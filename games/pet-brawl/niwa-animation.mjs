// User video frames: only its character rectangle is rendered, never the phone UI.
export const NIWA_LAUGH_FRAMES = Object.freeze(['2.200','2.400','2.600','2.800','3.000','3.200','3.400','3.600'].map(t => `./assets/niwa-laugh_${t}s.png`));
export const NIWA_LAUGH_CROP = Object.freeze({ x: 120, y: 420, width: 540, height: 840 });
export function laughFrameIndex(time, reduced = false) { return reduced ? 0 : Math.floor(Math.max(0, time) / .15) % NIWA_LAUGH_FRAMES.length; }
// Preload-time Canvas keying. Flood only edge-connected near-white pixels;
// enclosed white teeth/eyes remain intact. No pixel work in the animation loop.
export function clearFrameBackground(data, width, height) {
  const seen = new Uint8Array(width * height), queue = new Uint32Array(width * height); let start = 0, end = 0;
  const add = index => {
    if (seen[index]) return; seen[index] = 1;
    const p = index * 4, low = Math.min(data[p], data[p+1], data[p+2]), high = Math.max(data[p], data[p+1], data[p+2]);
    if (low > 225 && high-low < 20) { data[p+3] = 0; queue[end++] = index; }
  };
  for (let x=0; x<width; x++) { add(x); add((height-1)*width+x); }
  for (let y=0; y<height; y++) { add(y*width); add(y*width+width-1); }
  while (start<end) { const index=queue[start++], x=index%width, y=Math.floor(index/width); if(x>0)add(index-1);if(x+1<width)add(index+1);if(y>0)add(index-width);if(y+1<height)add(index+width); }
  return data;
}
export function prepareLaughFrame(image, document) {
  const frame = document.createElement('canvas'); frame.width = 180; frame.height = 280;
  const context=frame.getContext('2d',{willReadFrequently:true}), c=NIWA_LAUGH_CROP;
  context.drawImage(image,c.x,c.y,c.width,c.height,0,0,frame.width,frame.height);
  const pixels=context.getImageData(0,0,frame.width,frame.height);clearFrameBackground(pixels.data,frame.width,frame.height);context.putImageData(pixels,0,0);
  return frame;
}
