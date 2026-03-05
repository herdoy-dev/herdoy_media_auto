module.exports = {
  apps: [
    {
      name: "fbauto",
      script: "index.ts",
      interpreter: "bun",
      cwd: "/opt/fbauto",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
