import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    allowedHosts: ['boodschappen.stefhermans.nl']
  }
});
