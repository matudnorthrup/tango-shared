#!/usr/bin/env python3
"""Install a checksum-pinned Litestream binary in an explicit, new directory."""
import hashlib
import io
from pathlib import Path
import platform
import sys
import tarfile
import urllib.request

VERSION = '0.5.17'
SHA256 = 'e211f68ff7658d19f193f2914417afdf8f89a053ff8f263e5d6b3b1d3bbc7b08'
if platform.system() != 'Darwin' or platform.machine() != 'arm64':
    sys.exit('This verified installer supports Apple Silicon Macs only.')
if len(sys.argv) != 2:
    sys.exit('Usage: install-litestream.py NEW_DIRECTORY')
destination = Path(sys.argv[1]).resolve()
if destination.exists():
    sys.exit('Choose a new directory; existing installations are never overwritten.')
url = f'https://github.com/benbjohnson/litestream/releases/download/v{VERSION}/litestream-{VERSION}-darwin-arm64.tar.gz'
with urllib.request.urlopen(url, timeout=60) as response:
    archive = response.read()
if hashlib.sha256(archive).hexdigest() != SHA256:
    sys.exit('Litestream archive checksum mismatch')
with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
    member = next(m for m in tar.getmembers() if Path(m.name).name == 'litestream' and m.isfile())
    data = tar.extractfile(member).read()
destination.mkdir(parents=True, mode=0o700)
binary = destination / 'litestream'
binary.write_bytes(data)
binary.chmod(0o700)
print(binary)
