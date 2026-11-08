"""Reuse the isolated SQLite/Mock-only fixture in a new P86 evidence namespace."""

from p85_server import main

if __name__ == "__main__":
    main("p86")
