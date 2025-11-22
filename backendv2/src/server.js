// server.js
const dotenv = require("dotenv");
dotenv.config();

const app = require('./app.js');

const PORT = Number(process.env.PORT || 3000);

function start(port) {
  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`Servidor rodando em http://0.0.0.0:${port}`);
  });
  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      const next = port + 1;
      console.log(`Porta ${port} em uso, tentando ${next}...`);
      start(next);
    } else {
      throw err;
    }
  });
}

start(PORT);