const unameResult = Bun.spawnSync(["uname", "-a"]);
const uname = unameResult.stdout.toString().trim();

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: 8000,

  routes: {
    "/version": () =>
      Response.json({
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
        uname,
      }),
    "/*": Bun.file("/scripts/404.html"),
    "/": Bun.file("/scripts/index.html"),
    
  },

  fetch() {
    return new Response("404", { status: 404 });
  },
});

console.log(`Bun ${Bun.version} escuchando en ${server.url}`);