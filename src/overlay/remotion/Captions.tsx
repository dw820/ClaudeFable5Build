/**
 * Remotion caption composition (PRIMARY overlay path).
 *
 * Renders the base (cut) video as the backdrop and burns the EDL's caption track
 * on top. Captions arrive via inputProps already promoted to ABSOLUTE timings by
 * `edlToCaptionProps`, so this component is a dumb renderer: each caption is a
 * <Sequence> placed at its absolute start, fading in/out with interpolate().
 *
 * The base video is referenced by absolute filesystem path (a `file://` URL) via
 * <OffthreadVideo>, because the cut lives outside the bundle's public/ folder.
 *
 * Animation uses useCurrentFrame()/interpolate() only — CSS transitions do NOT
 * render correctly in Remotion.
 */
import React from "react";
import {
  AbsoluteFill,
  Composition,
  OffthreadVideo,
  Sequence,
  interpolate,
  registerRoot,
  useCurrentFrame,
  useVideoConfig,
  Easing,
  type CalculateMetadataFunction,
} from "remotion";
import {
  ASPECT_DIMENSIONS,
  type AbsoluteCaption,
  type CaptionInputProps,
} from "../captionProps.js";

export const CAPTIONS_COMPOSITION_ID = "Captions";
export const FPS = 30;

/** Seconds of fade applied at each end of a caption's window. */
const FADE_S = 0.15;

/** Convert an absolute file path to a URL Remotion's OffthreadVideo can load. */
function toFileUrl(p: string): string {
  if (p.startsWith("file://") || /^https?:\/\//.test(p)) return p;
  // Encode each path segment but keep the separators.
  const encoded = p.split("/").map(encodeURIComponent).join("/");
  return `file://${encoded}`;
}

/** One animated caption, positioned by style, fading in and out. */
const CaptionLine: React.FC<{ caption: AbsoluteCaption }> = ({ caption }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const durationInFrames = Math.max(1, Math.round((caption.endS - caption.startS) * fps));
  const fadeFrames = Math.min(Math.round(FADE_S * fps), Math.floor(durationInFrames / 2));

  const opacity = interpolate(
    frame,
    [0, fadeFrames, durationInFrames - fadeFrames, durationInFrames],
    [0, 1, 1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.bezier(0.16, 1, 0.3, 1),
    },
  );

  const justifyContent = caption.style.includes("top")
    ? "flex-start"
    : caption.style.includes("bottom")
      ? "flex-end"
      : "center";

  return (
    <AbsoluteFill
      style={{
        justifyContent,
        alignItems: "center",
        padding: "8%",
      }}
    >
      <div
        style={{
          opacity,
          fontFamily: "Helvetica, Arial, sans-serif",
          fontWeight: 800,
          fontSize: 72,
          color: "white",
          textAlign: "center",
          lineHeight: 1.1,
          padding: "16px 28px",
          borderRadius: 16,
          backgroundColor: "rgba(0,0,0,0.5)",
          textShadow: "0 2px 8px rgba(0,0,0,0.6)",
          whiteSpace: "pre-wrap",
        }}
      >
        {caption.text}
      </div>
    </AbsoluteFill>
  );
};

/** The composition: base video + the absolute-timed caption track. */
export const Captions: React.FC<CaptionInputProps> = ({ basePath, captions }) => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {basePath ? <OffthreadVideo src={toFileUrl(basePath)} /> : null}
      {captions.map((caption, i) => {
        const from = Math.round(caption.startS * fps);
        const durationInFrames = Math.max(
          1,
          Math.round((caption.endS - caption.startS) * fps),
        );
        return (
          <Sequence key={i} from={from} durationInFrames={durationInFrames}>
            <CaptionLine caption={caption} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

/** Derive duration + dimensions from inputProps so render matches the cut. */
const calculateMetadata: CalculateMetadataFunction<CaptionInputProps> = ({ props }) => {
  const dims = ASPECT_DIMENSIONS[props.aspect] ?? ASPECT_DIMENSIONS["9:16"];
  return {
    durationInFrames: Math.max(1, Math.ceil(props.durationS * FPS)),
    fps: FPS,
    width: dims.width,
    height: dims.height,
  };
};

const DEFAULT_PROPS: CaptionInputProps = {
  basePath: "",
  durationS: 1,
  captions: [],
  aspect: "9:16",
};

export const OverlayRoot: React.FC = () => {
  return (
    <Composition
      id={CAPTIONS_COMPOSITION_ID}
      component={Captions}
      fps={FPS}
      width={ASPECT_DIMENSIONS["9:16"].width}
      height={ASPECT_DIMENSIONS["9:16"].height}
      durationInFrames={1}
      defaultProps={DEFAULT_PROPS}
      calculateMetadata={calculateMetadata}
    />
  );
};

registerRoot(OverlayRoot);
