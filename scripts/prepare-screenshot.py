import io
import json
from pathlib import Path
import sys
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError


def encode(image, **options):
    result = io.BytesIO()
    image.save(result, format="WEBP", method=6, **options)
    return result.getvalue()


Image.MAX_IMAGE_PIXELS = 40_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)
try:
    with Image.open(io.BytesIO(sys.stdin.buffer.read()), formats=("PNG", "JPEG", "WEBP")) as source:
        if getattr(source, "is_animated", False):
            raise ValueError("the attachment must be a still image")
        oriented = ImageOps.exif_transpose(source)
        mode = "RGBA" if "A" in oriented.getbands() or "transparency" in oriented.info else "RGB"
        image = oriented.convert(mode)

    image.thumbnail((960, 960), Image.Resampling.LANCZOS)
    limit = 96 * 1024
    data = encode(image, lossless=True, quality=100)
    if len(data) > limit:
        data = encode(image, quality=85)
        while len(data) > limit:
            image.thumbnail((max(1, image.width * 4 // 5), max(1, image.height * 4 // 5)), Image.Resampling.LANCZOS)
            data = encode(image, quality=85)
    Path(sys.argv[1]).write_bytes(data)
    print(json.dumps({"width": image.width, "height": image.height}))
except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
    sys.exit(f"Invalid screenshot: {error}")
