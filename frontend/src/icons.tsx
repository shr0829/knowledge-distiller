import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function icon(path: ReactNode) {
  return function Icon({ size = 16, ...rest }: IconProps & { size?: number }) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        {...rest}
      >
        {path}
      </svg>
    );
  };
}

export const Search20Regular = icon(
  <>
    <circle cx="9" cy="9" r="5.2" />
    <path d="M12.9 12.9 16.5 16.5" />
  </>,
);

export const ArrowClockwise20Regular = icon(
  <>
    <path d="M16 9.8a6 6 0 1 1-1.9-4.6" />
    <path d="M16.2 4v4h-4" />
  </>,
);

export const ArrowDownload20Regular = icon(
  <>
    <path d="M10 3v8.5" />
    <path d="M6.6 8.4 10 11.8l3.4-3.4" />
    <path d="M4 15.5h12" />
  </>,
);

export const ArrowUndo20Regular = icon(
  <>
    <path d="M4 9.8a6 6 0 1 0 1.9-4.6" />
    <path d="M3.8 4v4h4" />
  </>,
);

export const BookOpen24Regular = icon(
  <>
    <path d="M10 5.2C8.2 4 6 3.6 4.2 3.8v11c1.8-.2 4 .2 5.8 1.4" />
    <path d="M10 5.2c1.8-1.2 4-1.6 5.8-1.4v11c-1.8-.2-4 .2-5.8 1.4" />
    <path d="M10 5.2v11" />
  </>,
);

export const Checkmark20Regular = icon(<path d="M4 10.6l3.4 3.4L16 5.4" />);

export const ChevronRight16Regular = icon(<path d="M7.5 4.5 13 10l-5.5 5.5" />);

export const Clock20Regular = icon(
  <>
    <circle cx="10" cy="10" r="6.4" />
    <path d="M10 6.4V10l2.6 1.7" />
  </>,
);

export const Code20Regular = icon(
  <>
    <path d="M7.2 6.4 3.6 10l3.6 3.6" />
    <path d="M12.8 6.4 16.4 10l-3.6 3.6" />
  </>,
);

export const DataUsage20Regular = icon(
  <>
    <path d="M4 16V9" />
    <path d="M8 16V4.5" />
    <path d="M12 16v-5" />
    <path d="M16 16V7" />
  </>,
);

export const Dismiss20Regular = icon(
  <>
    <path d="M5.5 5.5l9 9" />
    <path d="M14.5 5.5l-9 9" />
  </>,
);

export const Document20Regular = icon(
  <>
    <path d="M5.5 3.5h5.2L15.5 8v8.5h-10z" />
    <path d="M10.4 3.6V8h4.9" />
  </>,
);

export const DocumentAdd20Regular = icon(
  <>
    <path d="M5.5 3.5h5.2L15.5 8v8.5h-10z" />
    <path d="M10.4 3.6V8h4.9" />
    <path d="M10.5 11v4" />
    <path d="M8.5 13h4" />
  </>,
);

export const DocumentSearch20Regular = icon(
  <>
    <path d="M5.5 3.5h5.2L15.5 8v8.5h-10z" />
    <path d="M10.4 3.6V8h4.9" />
    <circle cx="9.6" cy="12.4" r="2.1" />
    <path d="M11.1 13.9 12.8 15.6" />
  </>,
);

export const Edit20Regular = icon(
  <>
    <path d="M12.4 4.2 15.8 7.6 8.4 15H5v-3.4z" />
    <path d="M10.6 6l3.4 3.4" />
  </>,
);

export const Filter20Regular = icon(
  <path d="M3.5 4.5h13l-5 5.8v5.2l-3-1.6v-3.6z" />,
);

export const Folder20Regular = icon(
  <path d="M3.2 6.2a1 1 0 0 1 1-1h3.4l1.6 2h6.6a1 1 0 0 1 1 1v7.1a1 1 0 0 1-1 1H4.2a1 1 0 0 1-1-1z" />,
);

export const History20Regular = icon(
  <>
    <path d="M3.8 10a6.2 6.2 0 1 0 1.9-4.5" />
    <path d="M3.5 3.8v4h4" />
    <path d="M10 6.8V10l2.4 1.6" />
  </>,
);

export const Info20Regular = icon(
  <>
    <circle cx="10" cy="10" r="6.4" />
    <path d="M10 9v4.2" />
    <path d="M10 6.6v.8" />
  </>,
);

export const Link20Regular = icon(
  <>
    <path d="M8.4 11.6 11.6 8.4" />
    <path d="M7.6 9.1 6 10.7a2.6 2.6 0 0 0 3.7 3.7l1.6-1.6" />
    <path d="M12.4 10.9 14 9.3a2.6 2.6 0 0 0-3.7-3.7l-1.6 1.6" />
  </>,
);

export const List20Regular = icon(
  <>
    <path d="M7 5.5h9" />
    <path d="M7 10h9" />
    <path d="M7 14.5h9" />
    <path d="M4 5.5h.01" />
    <path d="M4 10h.01" />
    <path d="M4 14.5h.01" />
  </>,
);

export const Play20Regular = icon(<path d="M7 4.6 15 10l-8 5.4z" />);

export const Settings20Regular = icon(
  <>
    <circle cx="10" cy="10" r="2.4" />
    <path d="M10 3.2v1.8M10 15v1.8M3.2 10H5M15 10h1.8M5.2 5.2l1.3 1.3M13.5 13.5l1.3 1.3M14.8 5.2l-1.3 1.3M6.5 13.5l-1.3 1.3" />
  </>,
);

export const ShieldCheckmark20Regular = icon(
  <>
    <path d="M10 3.2 15.4 5v5c0 3-2.2 5.4-5.4 6.8C6.8 15.4 4.6 13 4.6 10V5z" />
    <path d="M7.6 9.8 9.5 11.7l3-3.4" />
  </>,
);

export const Sparkle20Regular = icon(
  <>
    <path d="M10 3.4c.7 2.8 2 4.1 4.8 4.8-2.8.7-4.1 2-4.8 4.8-.7-2.8-2-4.1-4.8-4.8 2.8-.7 4.1-2 4.8-4.8z" />
    <path d="M14.8 12.6c.3 1.2.9 1.8 2.1 2.1-1.2.3-1.8.9-2.1 2.1-.3-1.2-.9-1.8-2.1-2.1 1.2-.3 1.8-.9 2.1-2.1z" />
  </>,
);
