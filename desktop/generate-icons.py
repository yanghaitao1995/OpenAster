"""Regenerate original OpenAster native icons from the public architectural A.
Requires Pillow only for developer asset generation, not runtime or normal builds.
"""
from pathlib import Path
import math
import re
import xml.etree.ElementTree as ET
from PIL import Image, ImageDraw, ImageChops

root = Path(__file__).resolve().parent / 'resources'
root.mkdir(exist_ok=True)
svg = ET.parse(root.parent.parent / 'public' / 'icon.svg').getroot()
ns = '{http://www.w3.org/2000/svg}'
if svg.tag != ns + 'svg' or svg.attrib != {'viewBox': '0 0 64 64'} or [child.tag for child in svg] != [ns + 'rect', ns + 'path']:
    raise ValueError('Review the native icon converter for this SVG structure')
rectangle, mark = list(svg)
if set(rectangle.attrib) != {'width', 'height', 'rx', 'fill'} or rectangle.attrib['width'] != '64' or rectangle.attrib['height'] != '64':
    raise ValueError('Unsupported icon background')
if set(mark.attrib) != {'d', 'fill', 'fill-rule'} or mark.attrib['fill-rule'] != 'evenodd':
    raise ValueError('Unsupported icon mark')
geometry = re.fullmatch(r'M([0-9. ]+)Z M([0-9. ]+)Z', mark.attrib['d'])
if geometry is None or any(re.fullmatch(r'#[0-9a-fA-F]{6}', node.attrib['fill']) is None for node in [rectangle, mark]):
    raise ValueError('Unsupported icon path or palette')
radius = float(rectangle.attrib['rx'])
polygons = [[float(value) for value in contour.split()] for contour in geometry.groups()]
if not math.isfinite(radius) or not 0 < radius <= 32 or any(len(points) < 6 or len(points) > 128 or len(points) % 2 or any(not math.isfinite(v) or not 0 <= v <= 64 for v in points) for points in polygons):
    raise ValueError('Unsupported icon geometry')
scale = 32
image = Image.new('RGBA', (64 * scale, 64 * scale))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((0, 0, 64 * scale - 1, 64 * scale - 1), radius=radius * scale, fill=rectangle.attrib['fill'])
mask = Image.new('1', image.size)
for coordinates in polygons:
    contour = Image.new('1', image.size)
    ImageDraw.Draw(contour).polygon([(x * scale, y * scale) for x, y in zip(coordinates[::2], coordinates[1::2])], fill=1)
    mask = ImageChops.logical_xor(mask, contour)
image.paste(mark.attrib['fill'], (0, 0), mask)
icon = image.resize((1024, 1024), Image.Resampling.LANCZOS)
icon.save(root / 'icon.png')
icon.save(root / 'icon.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
icon.save(root / 'icon.icns')
