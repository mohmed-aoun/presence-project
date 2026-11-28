// renderQr(container, text, size): draws a QR code as plain SVG.
// No canvas is used, so browsers that scramble canvas pixels (Brave, Firefox with
// anti-fingerprinting) cannot turn the code into coloured stripes.
// Needs vendor/qrcode-generator.js (MIT, Kazuhiko Arase) loaded first.
(function () {
  function renderQr(container, text, size) {
    size = size || 240;
    const qr = qrcode(0, 'M');      // type 0 = pick the smallest size that fits the text
    qr.addData(String(text), 'Byte');
    qr.make();

    const n = qr.getModuleCount();
    const quiet = 4;                // the empty white border QR scanners need
    const total = n + quiet * 2;

    // One path with a small square for every dark module.
    let d = '';
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        if (qr.isDark(row, col)) d += 'M' + (col + quiet) + ' ' + (row + quiet) + 'h1v1h-1z';
      }
    }

    container.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total + '"' +
      ' width="' + size + '" height="' + size + '" shape-rendering="crispEdges"' +
      ' role="img" aria-label="QR Code">' +
      '<rect width="100%" height="100%" fill="#ffffff"/>' +
      '<path d="' + d + '" fill="#000000"/></svg>';
  }

  window.renderQr = renderQr;
})();
