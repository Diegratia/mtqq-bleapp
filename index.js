const express = require("express");
const cors = require("cors");
const { initializeDatabase, getDbPool } = require("./database");
const { startMqttClient } = require("./mqtt");
const sql = require("mssql");
const path = require("path");

const app = express();
const port = 3000;

app.use(cors({ origin: "*" }));
app.use(express.static(path.join(__dirname, "public")));

async function saveToDatabase(data) {
  try {
    if (!data.obj || !Array.isArray(data.obj) || data.obj.length === 0) {
      console.warn("Invalid data received, skipping save:", data);
      return;
    }

    const gmac = data.gmac || data.obj[0].gmac;
    if (!gmac) {
      console.warn("No GMAC found in data, skipping save:", data);
      return;
    }

    const dbPool = getDbPool();

    await dbPool.request().input("gmac", sql.VarChar(12), gmac).query(`
        IF NOT EXISTS (SELECT 1 FROM gateways WHERE gmac = @gmac)
        INSERT INTO gateways (gmac) VALUES (@gmac);
      `);

    const gatewayResult = await dbPool
      .request()
      .input("gmac", sql.VarChar(12), gmac)
      .query(`SELECT id FROM gateways WHERE gmac = @gmac;`);

    const gatewayId = gatewayResult.recordset[0]?.id;
    if (!gatewayId) {
      throw new Error(
        `Gateway with gmac=${gmac} not found after insert/select`
      );
    }

    for (const obj of data.obj) {
      if (!obj.dmac) {
        console.warn("Beacon missing dmac, skipping:", obj);
        continue;
      }

      await dbPool
        .request()
        .input("gateway_id", sql.Int, gatewayId)
        .input("type", sql.TinyInt, obj.type)
        .input("dmac", sql.VarChar(12), obj.dmac)
        .input("refpower", sql.SmallInt, obj.refpower ?? null)
        .input("rssi", sql.Float, obj.rssi ?? null)
        .input("vbatt", sql.Int, obj.vbatt ?? null)
        .input("temp", sql.Float, obj.temp ?? null)
        .input("time", sql.DateTime, obj.time ? new Date(obj.time) : new Date())
        .query(`
          INSERT INTO beacons (
            gateway_id, type, dmac, refpower, rssi, vbatt, temp, time
          ) VALUES (
            @gateway_id, @type, @dmac, @refpower, @rssi, @vbatt, @temp, @time
          );
        `);
    }

    console.log(`Saved beacons for gateway ${gmac} successfully.`);
  } catch (error) {
    console.error("Error saving to database:", error.message, error.stack);
  }
}

app.get("/beacons-data", async (req, res) => {
  try {
    const dbPool = getDbPool();
    const result = await dbPool.request().query(`
      SELECT g.gmac, b.dmac, b.type, b.vbatt, b.temp, b.rssi, b.refpower
      FROM beacons b
      JOIN gateways g ON b.gateway_id = g.id
      ORDER BY g.gmac, b.dmac, b.type;
    `);

    const rows = result.recordset;
    const groupedByGmac = {};
    const finalResult = [];

    rows.forEach((row) => {
      const { gmac, dmac, type, vbatt, temp, rssi, refpower } = row;

      if (!groupedByGmac[gmac]) {
        groupedByGmac[gmac] = {
          gmac: gmac,
          beacons: {},
        };
        finalResult.push(groupedByGmac[gmac]);
      }

      if (!groupedByGmac[gmac].beacons[dmac]) {
        groupedByGmac[gmac].beacons[dmac] = {
          type1: [],
          type4: [],
        };
      }

      if (type === 1) {
        groupedByGmac[gmac].beacons[dmac].type1.push({ vbatt, temp });
      } else if (type === 4) {
        groupedByGmac[gmac].beacons[dmac].type4.push({ rssi, refpower });
      }
    });

    res.json({
      message: "Data berhasil diambil",
      data: finalResult,
    });
  } catch (error) {
    console.error("Error fetching beacons data:", error.message);
    res.status(500).json({
      message: "Gagal ambil data",
      error: error.message,
    });
  }
});

app.get("/rssi-chart-data", async (req, res) => {
  try {
    const dbPool = getDbPool();
    const result = await dbPool.request().query(`
      SELECT g.gmac, b.dmac, b.rssi
      FROM beacons b
      JOIN gateways g ON b.gateway_id = g.id
      WHERE b.rssi IS NOT NULL
      ORDER BY g.gmac, b.dmac, b.id;
    `);

    const data = result.recordset.map((row) => ({
      gmac: row.gmac,
      dmac: row.dmac,
      rssi: row.rssi,
    }));

    res.json({
      message: "RSSI data per beacon fetched",
      data: data,
    });
  } catch (error) {
    console.error("Error get chart data:", error.message);
    res.status(500).json({
      message: "Fetch failed",
      error: error.message,
    });
  }
});

app.get("/", (req, res) => {
  res.json({ message: "Server is running" });
});

async function startServer() {
  try {
    await initializeDatabase();
    startMqttClient(saveToDatabase);
    app.listen(port, () => {
      console.log(`HTTP server running at http://localhost:${port}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error.message);
  }
}

startServer();
