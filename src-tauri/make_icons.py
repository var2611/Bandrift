import base64
import os

os.makedirs('icons', exist_ok=True)
png_data = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=')

for ext in ['png', 'ico', 'icns']:
    with open(f'icons/icon.{ext}', 'wb') as f:
        f.write(png_data)
for size in ['32x32', '128x128', '128x128@2x']:
    with open(f'icons/{size}.png', 'wb') as f:
        f.write(png_data)
