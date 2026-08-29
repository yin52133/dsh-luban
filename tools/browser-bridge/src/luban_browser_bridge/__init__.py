"""Luban's isolated browser-use JSONL bridge."""

from .errors import BridgeError
from .server import BridgeServer
from .version import BRIDGE_VERSION

__all__ = ["BridgeError", "BridgeServer"]
__version__ = BRIDGE_VERSION
