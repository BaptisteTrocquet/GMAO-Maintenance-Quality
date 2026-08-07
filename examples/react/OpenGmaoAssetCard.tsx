import type { CSSProperties } from "react";

export type OpenGmaoAssetCardProps = {
  baseUrl: string;
  tokenId: string;
  token: string;
  assetCode: string;
  theme?: {
    accent?: string;
    background?: string;
    surface?: string;
    text?: string;
    radius?: number;
  };
};

export function OpenGmaoAssetCard({
  baseUrl,
  tokenId,
  token,
  assetCode,
  theme,
}: OpenGmaoAssetCardProps) {
  const url = new URL("/embed/asset-card", baseUrl);
  url.searchParams.set("tokenId", tokenId);
  url.searchParams.set("assetCode", assetCode);
  if (theme?.accent) url.searchParams.set("themeAccent", theme.accent);
  if (theme?.background) url.searchParams.set("themeBackground", theme.background);
  if (theme?.surface) url.searchParams.set("themeSurface", theme.surface);
  if (theme?.text) url.searchParams.set("themeText", theme.text);
  if (theme?.radius !== undefined) url.searchParams.set("themeRadius", String(theme.radius));
  url.hash = new URLSearchParams({ token }).toString();

  const style: CSSProperties = {
    width: "100%",
    maxWidth: 680,
    height: 430,
    border: 0,
    display: "block",
  };

  return (
    <iframe
      title={`Asset ${assetCode}`}
      src={url.toString()}
      referrerPolicy="strict-origin"
      sandbox="allow-scripts allow-same-origin"
      loading="lazy"
      style={style}
    />
  );
}
