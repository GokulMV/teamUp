// A fixed-step game loop that keeps to real time. Each wake-up runs every step the clock says is
// due, so a busy moment on the server (a garbage collection, another room starting a match) is
// caught up at once. A plain setInterval of fixed steps would leave the game behind real time for
// good, and every player's view of the others would run out of snapshots and stutter.
// Returns a handle with stop(); step(dt) may call it to end the loop mid-catch-up.
function fixedLoop(hz, step, maxLag = 0.5) {
  const dt = 1 / hz;
  let last = performance.now();
  let owed = 0;
  let timer = null;
  const handle = {
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
  timer = setInterval(() => {
    const now = performance.now();
    owed = Math.min(owed + (now - last) / 1000, maxLag);
    last = now;
    while (timer && owed >= dt - 1e-4) {
      owed -= dt;
      step(dt);
    }
  }, 1000 / hz);
  return handle;
}

module.exports = { fixedLoop };
