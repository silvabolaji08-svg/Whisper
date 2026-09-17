/**
 * The Whisper wordmark: handwriting that writes itself in.
 *
 * The reveal is a clip-path sweeping left to right, which reads as the word
 * being written and, unlike an SVG stroke animation, works with any font and
 * needs no path data. A soft nib follows the leading edge.
 *
 * Handwriting is used for the name only. Body text stays in the UI face —
 * a script at small sizes is hard to read, and this one carries the brand
 * rather than the interface.
 */
export default function Wordmark({
  className = "",
  showNib = true,
}: {
  className?: string;
  /** The travelling dot; turn it off where the mark is decorative. */
  showNib?: boolean;
}) {
  return (
    <span className={`wordmark ${className}`}>
      <span className="wordmark-ink">Whisper</span>
      {showNib ? <span className="wordmark-nib" aria-hidden="true" /> : null}
    </span>
  );
}
