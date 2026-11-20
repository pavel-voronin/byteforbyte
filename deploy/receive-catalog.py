import os
import re
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import jwt


ISSUER = "https://token.actions.githubusercontent.com"
AUDIENCE = "https://byteforbyte.dev/_deploy/catalog"
REPOSITORY_ID = "1462397551"
MAIN_REF = "refs/heads/main"
WORKFLOW = "pavel-voronin/byteforbyte/.github/workflows/catalog.yml@" + MAIN_REF
STAGING = Path("/srv/byteforbyte/staging")
PUBLIC_FILE = Path("/srv/byteforbyte/public/index.html")
MAX_BYTES = 1024 * 1024
KEYS = jwt.PyJWKClient(ISSUER + "/.well-known/jwks", timeout=5)


def authorized_revision(token):
    key = KEYS.get_signing_key_from_jwt(token)
    claims = jwt.decode(
        token,
        key.key,
        algorithms=["RS256"],
        audience=AUDIENCE,
        issuer=ISSUER,
        options={"require": ["exp", "iat", "nbf"]},
    )
    revision = claims.get("sha", "")
    if (
        claims.get("repository_id") != REPOSITORY_ID
        or claims.get("ref") != MAIN_REF
        or claims.get("workflow_ref") != WORKFLOW
        or claims.get("job_workflow_ref", WORKFLOW) != WORKFLOW
        or claims.get("event_name") not in {"push", "workflow_dispatch"}
        or not re.fullmatch(r"[0-9a-f]{40}", revision)
    ):
        raise jwt.InvalidTokenError("Unauthorized workflow")
    return revision


def publish_catalog(html):
    with tempfile.NamedTemporaryFile(dir=STAGING, delete=False) as temporary:
        staged = Path(temporary.name)
        try:
            temporary.write(html)
            temporary.close()
            staged.chmod(0o644)
            os.replace(staged, PUBLIC_FILE)
        finally:
            staged.unlink(missing_ok=True)


class CatalogUpload(BaseHTTPRequestHandler):
    def do_PUT(self):
        if self.path != "/_deploy/catalog":
            self.send_error(404)
            return
        token_type, _, token = self.headers.get("Authorization", "").partition(" ")
        if token_type != "Bearer" or not token:
            self.send_error(401)
            return
        try:
            revision = authorized_revision(token)
        except jwt.PyJWKClientConnectionError:
            self.send_error(503, "GitHub signing keys unavailable")
            return
        except (jwt.PyJWTError, ValueError, TypeError):
            self.send_error(403)
            return

        length = self.headers.get("Content-Length", "")
        if not re.fullmatch(r"[0-9]{1,7}", length):
            self.send_error(411)
            return
        size = int(length)
        if size > MAX_BYTES:
            self.send_error(413)
            return
        self.connection.settimeout(10)
        try:
            html = self.rfile.read(size)
        except TimeoutError:
            self.send_error(408)
            return
        marker = f'<meta name="catalog-revision" content="{revision}">'.encode()
        if len(html) != size or not html.startswith(b"<!doctype html>\n") or marker not in html.splitlines():
            self.send_error(400, "Catalog does not match the workflow revision")
            return

        try:
            publish_catalog(html)
        except OSError:
            self.send_error(500, "Could not install catalog")
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(f"Published {revision}\n".encode())


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 18273), CatalogUpload).serve_forever()
