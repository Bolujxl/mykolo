type LogoProps = {
  size?: number;
  className?: string;
  /** Pot fill. Defaults to the theme's primary so it self-adapts on normal surfaces. */
  color?: string;
  /** Coin-slot cutout fill. Defaults to the theme's background for the self-inverting trick. */
  notchColor?: string;
};

/**
 * Abstract kolo silhouette: a single rounded clay-pot shape in `primary`,
 * with a coin-slot notch cut using the current background color so it
 * self-inverts between light and dark mode without a second logo file.
 * `color`/`notchColor` let callers override this for placements over
 * non-standard backgrounds (e.g. the animated auth visual panel).
 */
export function Logo({
  size = 32,
  className,
  color = "var(--color-primary)",
  notchColor = "var(--color-background)",
}: LogoProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="KoloVault"
    >
      <path
        d="M16 3c1.1 0 2 .9 2 2v1.06c5.1.9 9 5.35 9 10.69 0 5.98-4.92 10.75-11 10.75S5 22.73 5 16.75c0-5.34 3.9-9.79 9-10.69V5c0-1.1.9-2 2-2Z"
        fill={color}
      />
      <rect x="12.5" y="6" width="7" height="2.4" rx="1.2" fill={notchColor} />
    </svg>
  );
}
