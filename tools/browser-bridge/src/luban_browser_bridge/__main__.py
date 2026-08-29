"""Console entry point."""

from __future__ import annotations

import asyncio

from .security import configure_logging
from .server import BridgeServer, serve_stdio


def main() -> None:
    configure_logging()
    asyncio.run(serve_stdio(BridgeServer()))


if __name__ == "__main__":
    main()
