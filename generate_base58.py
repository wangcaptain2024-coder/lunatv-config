import base64
from pathlib import Path

src = Path("LunaTV-config.json")
dst = Path("config.b58")

data = src.read_bytes()

# Base58 编码
ALPHABET = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

n = int.from_bytes(data, "big")
encoded = bytearray()

while n > 0:
    n, r = divmod(n, 58)
    encoded.append(ALPHABET[r])

# 保留原始数据前导 0
for b in data:
    if b == 0:
        encoded.append(ALPHABET[0])
    else:
        break

encoded.reverse()

dst.write_bytes(bytes(encoded))

print(f"Generated {dst}: {dst.stat().st_size} bytes")
