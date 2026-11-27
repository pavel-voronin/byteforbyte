# Byte for Byte

A catalog of source code restorations for games and software from DOS and other classic platforms. The projects listed here reproduce original binaries byte for byte.

[Browse the catalog](https://byteforbyte.dev/) · [Add a project](https://github.com/pavel-voronin/byteforbyte/issues/new?template=add-project.yml)

## Find new projects

[Catalog discovery](https://github.com/pavel-voronin/byteforbyte/actions/workflows/discovery.yml) runs daily at 01:17 UTC. You can also select **Run workflow**. Read the run summary for the first 25 candidates. Download the `catalog-candidates` artifact for the full list and source results. A source error fails the run and the artifact still contains the available results.

For a local run, set `GITHUB_TOKEN` with read access and run `node scripts/discover-projects.mjs <output-folder>` with Node.js 22 or later. Review the original release and its build verification before opening a catalog issue.
