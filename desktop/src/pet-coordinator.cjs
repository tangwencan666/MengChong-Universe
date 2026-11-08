'use strict';
// Rules observe only same-owner geometry and public definitions, never chat or memory.
function createCoordinator() {
    let nextAt = 0, pairIndex = 0;
    return {
        clear() { nextAt = 0; pairIndex = 0; },
        plan(records, now) {
            if (now < nextAt)
                return [];
            nextAt = now + 90000;
            const eligible = records.filter(r => r.visible && r.random && r.priority < 25);
            const pairs=[];
            for(let one=0;one<eligible.length;one++)for(let two=one+1;two<eligible.length;two++){
                const a=eligible[one],b=eligible[two];
                if(a.id!==b.id&&a.owner===b.owner&&a.display===b.display&&Math.hypot(a.x-b.x,a.y-b.y)<=600)pairs.push([a,b]);
            }
            if (!pairs.length)
                return [];
            const [first,second]=pairs[pairIndex++%pairs.length];
            const maodie=first.definition==='hajimi'&&second.definition==='maodie'?second:first;
            const hajimi=maodie===first?second:first;
            return [
                { id: maodie.id, action: maodie.autoMove && hajimi.autoMove ? 'follow' : 'look', toward: hajimi.id },
                { id: hajimi.id, action: maodie.autoMove && hajimi.autoMove ? 'evade' : 'turn', toward: maodie.id },
            ];
        },
    };
}
// A single short step, not continuous pursuit. The host still checks display,
// overlap, visibility, dragging and the user's movement switch.
function interactionStep(action, self, other) {
    if (!['follow', 'evade'].includes(action) || ![self?.x, self?.y, other?.x, other?.y].every(Number.isFinite))
        return null;
    const dx = other.x - self.x, dy = other.y - self.y, distance = Math.hypot(dx, dy);
    if (distance < 1)
        return null;
    const step = action === 'follow' ? 70 : -60;
    return { x: self.x + dx / distance * step, y: self.y + dy / distance * step };
}
module.exports = { createCoordinator, interactionStep };
