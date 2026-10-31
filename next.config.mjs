/** @type {import('next').NextConfig} */
const nextConfig = {
  // The API reads the committed records at request time.
  outputFileTracingIncludes: {
    "/api/**": ["./data/**/*", "./config/**/*"],
  },
};
export default nextConfig;
