// Health routes extracted with no behaviour changes

export function mountHealthRoutes(app) {
  app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });
}

export default mountHealthRoutes;
