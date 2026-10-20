// The five games' emoji (home page tiles and lobby cards), each with the bits it needs to act out
// its game when the card is hovered, focused or tapped (style.css, "Game art"): the palette paints
// a stroke with its brush, the phone rings and is answered, the car revs and races off, the control
// panel twiddles until it blows, and the chain is tugged one way and the other.
(function () {
  const ART = {
    pictionary: `<span class="em">🎨</span>
      <svg class="fx fx-stroke" viewBox="0 0 64 32" aria-hidden="true"><path pathLength="100" d="M4 24 C 14 4, 22 30, 32 15 S 50 6, 60 20"/></svg>
      <span class="fx fx-brush">🖌️</span>`,
    telephone: `<span class="fx fx-ring fx-ring-l">(</span><span class="em">📞</span><span class="fx fx-ring fx-ring-r">)</span>
      <span class="fx fx-bubble"><i></i><i></i><i></i></span>`,
    kart: `<span class="em">🏎️</span><span class="fx fx-puff">💨</span><span class="fx fx-puff fx-puff2">💨</span>
      <span class="fx fx-lines"><i></i><i></i><i></i></span>`,
    ballchain: `<span class="fx fx-pull fx-pull-l">‹‹</span><span class="em">⛓️</span><span class="fx fx-pull fx-pull-r">››</span>`,
    controlroom: `<span class="em">🎛️</span><span class="fx fx-blast">💥</span><span class="fx fx-spark">✨</span>`,
  };
  const html = (mode) => (ART[mode] ? `<span class="game-art ga-${mode}" aria-hidden="true">${ART[mode]}</span>` : '');
  window.GameArt = { html, modes: Object.keys(ART) };
})();
