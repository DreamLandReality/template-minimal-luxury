import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: process.env.SITE_URL || 'http://localhost:4321',
  integrations: [
    tailwind(),
    sitemap()
  ],
  build: {
    format: 'directory'
  }
});
