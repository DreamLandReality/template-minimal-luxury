import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://template-minimal-luxury.pages.dev', // Replaced at deploy time
  integrations: [
    tailwind(),
    sitemap()
  ],
  build: {
    format: 'directory'
  }
});
