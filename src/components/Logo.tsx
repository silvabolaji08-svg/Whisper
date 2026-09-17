/**
 * The Whisper mark: two overlapping speech bubbles on a gradient squircle.
 *
 * Drawn as vector rather than shipped as a raster so it stays crisp at every
 * size and can be recoloured from one place. The same geometry is duplicated in
 * `src/app/icon.svg`, which Next serves as the favicon — keep the two in step.
 *
 * The gradient id is fixed rather than generated: every instance defines an
 * identical gradient, so a repeated id resolves to the same paint.
 */
export default function Logo({
  size = 56,
  className = "",
  title,
}: {
  size?: number;
  className?: string;
  /** Give this only where the mark is the sole label; otherwise decorative. */
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <linearGradient
          id="whisper-mark"
          x1="4"
          y1="2"
          x2="58"
          y2="62"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#6E86FF" />
          <stop offset="0.5" stopColor="#3F46F0" />
          <stop offset="1" stopColor="#2A18C8" />
        </linearGradient>
      </defs>

      {/* Squircle. rx is ~28% of the box, which reads as an app icon. */}
      <rect width="64" height="64" rx="18" fill="url(#whisper-mark)" />
      {/* A faint inner edge, so the mark keeps its shape on a light background. */}
      <rect
        x="0.5"
        y="0.5"
        width="63"
        height="63"
        rx="17.5"
        stroke="#000000"
        strokeOpacity="0.10"
      />

      {/* Back bubble, tail to the lower right. Drawn first so the white one
          overlaps it. */}
      <path
        d="M38 28h9a6 6 0 0 1 6 6v3a6 6 0 0 1-6 6h-1.6l3.1 5.2a.6.6 0 0 1-.85.8L40 43H38a6 6 0 0 1-6-6v-3a6 6 0 0 1 6-6Z"
        fill="#FFFFFF"
        fillOpacity="0.45"
      />

      {/* Front bubble, tail to the lower left. */}
      <path
        d="M20 15h14a8 8 0 0 1 8 8v6a8 8 0 0 1-8 8h-9.6l-6.9 5.6a.8.8 0 0 1-1.3-.62V36.4A8 8 0 0 1 12 29v-6a8 8 0 0 1 8-8Z"
        fill="#FFFFFF"
      />

      {/* Three dots, in the deeper end of the gradient. */}
      <circle cx="21.5" cy="26" r="2.9" fill="#3A42EE" />
      <circle cx="30" cy="26" r="2.9" fill="#3A42EE" />
      <circle cx="38.5" cy="26" r="2.9" fill="#3A42EE" />
    </svg>
  );
}
