import type { APIRoute } from 'astro';
import { getSectionData, getTheme } from '../lib/manifest-loader';

export const GET: APIRoute = () => {
  const seo = getSectionData('seo') as any;
  const theme = getTheme();

  const name = seo.structuredData?.propertyName || seo.title || 'Property Site';
  const shortName = name.length > 20 ? name.slice(0, 20) : name;
  const themeColor = theme?.colors?.primary || '#1c1917';
  const backgroundColor = theme?.colors?.background || '#ffffff';

  const manifest = {
    name,
    short_name: shortName,
    description: seo.description || '',
    start_url: '/',
    display: 'browser',
    theme_color: themeColor,
    background_color: backgroundColor,
    icons: [
      { src: '/favicon.svg', type: 'image/svg+xml', sizes: 'any' },
    ],
  };

  return new Response(JSON.stringify(manifest, null, 2), {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
    },
  });
};
