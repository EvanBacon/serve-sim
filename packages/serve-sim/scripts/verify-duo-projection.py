#!/usr/bin/env python3
"""Check projected points against actual rendered markers across folds and rotations."""
import subprocess,struct,json,io,math
from PIL import Image,ImageDraw
from pathlib import Path
import argparse
# Requires Pillow and a built local renderer; reads the model from selected Xcode.
package = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--renderer', default=str(package / 'dist/simduo/serve-sim-duo-render'))
args = parser.parse_args()
developer = subprocess.check_output(['xcode-select', '-p'], text=True).strip()
model = str(Path(developer).parent / 'SharedFrameworks/DeviceKit.framework/Versions/A/PlugIns/CoreDevicePopDeviceKitExtension.devicekitplugin/Contents/Resources/V68.usdz')
def exact(stream, count):
 data = bytearray()
 while len(data) < count:
  chunk = stream.read(count - len(data))
  if not chunk: raise RuntimeError('Renderer ended early')
  data.extend(chunk)
 return bytes(data)
im=Image.new('RGB',(1000,1000),'white');draw=ImageDraw.Draw(im)
markers=[(.25,.25,(255,0,0)),(.75,.25,(0,255,0)),(.25,.75,(0,0,255)),(.75,.75,(255,0,255))]
for u,v,c in markers:draw.ellipse((u*1000-10,v*1000-10,u*1000+10,v*1000+10),fill=c)
buf=io.BytesIO();im.save(buf,format='PNG');source=buf.getvalue()
def project(piece,u,v):
 p0,p1,p2,p3,r=piece;u=(u-r[0])/r[2];v=(v-r[1])/r[3]
 dx1=p1[0]-p2[0];dx2=p3[0]-p2[0];dy1=p1[1]-p2[1];dy2=p3[1]-p2[1]
 sx=p0[0]-p1[0]+p2[0]-p3[0];sy=p0[1]-p1[1]+p2[1]-p3[1];d=dx1*dy2-dx2*dy1
 g=(sx*dy2-dx2*sy)/d;h=(dx1*sy-sx*dy1)/d
 return [((p1[k]-p0[k]+g*p1[k])*u+(p3[k]-p0[k]+h*p3[k])*v+p0[k])/(1+g*u+h*v) for k in [0,1]]
p=subprocess.Popen([args.renderer,model],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=None)
try:
 for panel,angle,roll in [('inner',a,r) for a in [180,170,130,100] for r in [0,90,180,270]] + [('cover',0,r) for r in [0,90,180,270]]:
  h=json.dumps(dict(jpegLength=len(source),panel=panel,hingeDegrees=angle,rollDegrees=roll,fullResolution=False)).encode();p.stdin.write(struct.pack('>I',len(h))+h+source);p.stdin.flush()
  out=json.loads(exact(p.stdout,struct.unpack('>I',exact(p.stdout,4))[0]));png=exact(p.stdout,out['jpegLength']);render=Image.open(io.BytesIO(png)).convert('RGB')
  errors=[]
  for u,v,c in markers:
   xy=project(out['pieces'][0 if panel=='cover' or v>.5 else 1],u,v);x,y=xy[0]*render.width,xy[1]*render.height
   pts=[]
   for yy in range(max(0,int(y)-80),min(render.height,int(y)+81)):
    for xx in range(max(0,int(x)-80),min(render.width,int(x)+81)):
     pixel=render.getpixel((xx,yy))
     if all(abs(pixel[k]-c[k])<15 for k in range(3)):pts.append((xx,yy))
   if not pts:errors.append('MISSING');continue
   cx=sum(a for a,b in pts)/len(pts);cy=sum(b for a,b in pts)/len(pts);errors.append(round(math.hypot(cx-x,cy-y),2))
  print(panel,angle,roll,errors,flush=True)
  assert all(isinstance(e,float) and e < 2 for e in errors), errors
finally:p.terminate()
