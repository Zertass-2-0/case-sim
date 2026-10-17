// All configuration comes from environment variables (set in compose.yaml from .env).
function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable ${name}`);
    process.exit(1);
  }
  return value;
}

module.exports = {
  port: Number(process.env.APP_PORT || 3000),
  db: {
    host: required("DB_HOST"),
    port: Number(process.env.DB_PORT || 5432),
    user: required("DB_USER"),
    password: required("DB_PASSWORD"),
    database: required("DB_NAME"),
  },
  jwtSecret: required("JWT_SECRET"),
  startingBalance: Number(process.env.STARTING_BALANCE || 1000),
  admin: {
    nick: process.env.ADMIN_NICK || "",
    password: process.env.ADMIN_PASSWORD || "",
  },
};
