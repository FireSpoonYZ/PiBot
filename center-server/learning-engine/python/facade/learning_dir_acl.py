"""Create private directories for per-Bot learning state."""

from pathlib import Path


def make_user_dir(path, *, parents=False, exist_ok=False):
    Path(path).mkdir(mode=0o700, parents=parents, exist_ok=exist_ok)
