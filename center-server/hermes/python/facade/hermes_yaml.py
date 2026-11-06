"""YAML parsing through the center's existing bounded YAML implementation."""

import transport


def safe_load(stream):
    document = stream if isinstance(stream, (str, bytes)) else stream.read()
    if isinstance(document, bytes):
        document = document.decode("utf-8")
    return transport.call("yaml.parse", {"source": document})


def safe_dump(*_args, **_kwargs):
    raise NotImplementedError("YAML writing is not used by the learning adapter")
