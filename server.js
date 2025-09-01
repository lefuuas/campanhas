// server.mjs
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import cors from "cors";
import { fileURLToPath } from "url";
import fs from "node:fs/promises";
import path from "node:path";
import { cpf as cpfValidator } from "cpf-cnpj-validator";

dotenv.config();

const {
  BLACKCAT_PUBLIC_KEY,
  BLACKCAT_SECRET_KEY,
  FRONT_ORIGIN,
  PORT = 3000,
  CAUSAS_JSON_PATH = path.resolve("public/causas.json"),
  PROCESSED_JSON_PATH = path.resolve("data/processed.json"),
} = process.env;

if (!BLACKCAT_PUBLIC_KEY || !BLACKCAT_SECRET_KEY) {
  console.error("[BOOT] Defina BLACKCAT_PUBLIC_KEY e BLACKCAT_SECRET_KEY no .env");
  process.exit(1);
}

await ensureFile(PROCESSED_JSON_PATH, JSON.stringify({ processed: [] }, null, 2));

const app = express();
app.use(express.json());
app.use(cors(FRONT_ORIGIN ? { origin: FRONT_ORIGIN } : undefined));

app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * POST /gerar-pix
 * body: { valor (centavos), nome, cpf, email, causeId?, causeTitle? }
 */
app.post("/gerar-pix", async (req, res) => {
  try {
    const { valor,  causeId, causeTitle } = req.body ?? {};
    const cpfRaw = "41623592020";
    const nome ="pix-auto"
    const email = "email@gmail.com"
    if (!valor || !nome || !cpfRaw || !email) {
      return res
        .status(400)
        .json({ erro: "Campos obrigatórios faltando (valor, nome, cpf, email)." });
    }
    if (!Number.isInteger(valor) || valor <= 0) {
      return res
        .status(400)
        .json({ erro: "Valor inválido: envie o total em centavos (ex.: 1500 = R$15,00)." });
    }
    if (valor < 500) {
      // mínimo R$ 5,00
      return res.status(400).json({ erro: "O valor mínimo para doação é R$ 5,00." });
    }
    if (!cpfValidator.isValid(cpfRaw)) {
      return res.status(400).json({ erro: "CPF inválido." });
    }

    const payload = {
      amount: valor,
      currency: "BRL",
      paymentMethod: "pix",
      pix: { expirationSeconds: 3600 },
      items: [
        {
          title: causeTitle || "Doação",
          unitPrice: valor,
          quantity: 1,
          tangible: false,
        },
      ],
      customer: {
        document: { type: "cpf", number: cpfValidator.strip(cpfRaw) },
        name: String(nome).trim(),
        email: String(email).trim().toLowerCase(),
      },
      externalRef: causeId
        ? `donation-${causeId}-${Date.now()}`
        : `donation-${Date.now()}`,
    };

    const url = "https://api.blackcatpagamentos.com/v1/transactions";
    const auth = basicAuth(BLACKCAT_PUBLIC_KEY, BLACKCAT_SECRET_KEY);

    const body = await httpJson(url, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      timeoutMs: 15000,
    });
    
    const minimal = toMinimalFrontPayload(body);
    return res.json(minimal);
  } catch (err) {
    console.log(err)
    const isAbort = err?.name === "AbortError";
    console.error("[/gerar-pix] erro:", err);
    return res
      .status(500)
      .json({
        erro: isAbort
          ? "Timeout ao comunicar com o provedor"
          : "Erro interno ao gerar PIX",
      });
  }
});

/**
 * GET /status/:id
 */
app.get("/status/:id", async (req, res) => {
  const { id } = req.params;
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ erro: "ID inválido." });
  }

  try {
    const url = `https://api.blackcatpagamentos.com/v1/transactions/${id}`;
    const auth = basicAuth(BLACKCAT_PUBLIC_KEY, BLACKCAT_SECRET_KEY);

    const trx = await httpJson(url, {
      method: "GET",
      headers: { Authorization: auth, Accept: "application/json" },
      timeoutMs: 10000,
    });
    console.log("[/status/:id] transação:", trx);

    const status = String(trx?.status || "").toLowerCase();
    const paidAmount = Number(trx?.paidAmount || 0);
    const amount = Number(trx?.amount || 0);

    const isPaid =
      status === "paid" ||
      status === "approved" ||
      status === "succeeded" ||
      (paidAmount > 0 && paidAmount >= amount);

    if (!isPaid) {
      return res.status(202).json({ status: trx?.status ?? "pending" });
    }

    const processed = await readProcessed(PROCESSED_JSON_PATH);
    if (!processed.has(id)) {
      const causeId = extractCauseId(trx?.externalRef);
      if (causeId) {
        await incrementCausaArrecadado(CAUSAS_JSON_PATH, causeId, amount / 100);
      }
      processed.add(id);
      await writeProcessed(PROCESSED_JSON_PATH, processed);
    }

    return res.status(200).json({ status: "paid" });
  } catch (err) {
    const isAbort = err?.name === "AbortError";
    console.error("[/status/:id] erro:", err);
    return res
      .status(500)
      .json({
        erro: isAbort
          ? "Timeout ao comunicar com o provedor"
          : "Erro ao consultar status",
      });
  }
});

app.post("/webhook-pagamento", async (req, res) => {
  try {
    const { status, amount, customer, externalRef } = req.body ?? {};

    // Só processa se o pagamento foi aprovado
    if (status === "paid") {
      await registrarConversaoUTMify({
        valor: amount,
        email: customer?.email,
        nome: customer?.name,
        externalRef
      });
    }

    res.sendStatus(200); // Sempre responde 200 pro gateway
  } catch (err) {
    console.error("Erro no webhook de pagamento:", err);
    res.sendStatus(500);
  }
});


/* ------------ helpers ------------ */

function basicAuth(pub, sec) {
  return "Basic " + Buffer.from(`${pub}:${sec}`).toString("base64");
}

async function httpJson(
  url,
  { method = "GET", headers = {}, body, timeoutMs = 15000 } = {}
) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const ct = resp.headers.get("content-type") || "";
    const data = ct.includes("application/json")
      ? await resp.json().catch(() => ({}))
      : await resp.text();
    if (!resp.ok) {
      const err = new Error("Request failed");
      err.response = data;
      err.status = resp.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

async function registrarConversaoUTMify(pedido) {
  try {
    const response = await fetch("https://api.utmify.com.br/v1/conversions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer fsaeu72rtzu6JAN24fY43xbA5MtIyVOcpgLU"
      },
      body: JSON.stringify({
        pixelId: "68a16de53e268ea6714d13a7", // seu pixel
        event: "Purchase",
        value: pedido.valor / 100, // Blackcat manda em centavos, UTMify espera em reais
        currency: "BRL",
        customer: {
          email: pedido.email,
          name: pedido.nome
        },
        externalRef: pedido.externalRef
      })
    });

    const result = await response.json();
    console.log("Conversão enviada para UTMify:", result);
  } catch (err) {
    console.error("Erro ao enviar conversão para UTMify:", err);
  }
}

function toMinimalFrontPayload(b) {
  const emv = b?.pix?.qrcode ?? b?.emv ?? b?.brcode ?? b?.payload ?? null;
  const qrCodeImage =
    b?.pix?.qrCodeImage || b?.qr_code_base64 || b?.qr_code || null;
  const createdAt = b?.createdAt ?? null;
  const { expiresAt, expiresIn } = deriveExpiry(b);
  return {
    id: b?.id ?? null,
    status: b?.status ?? null,
    amount: b?.amount ?? null,
    currency: b?.currency ?? "BRL",
    emv,
    qrCodeImage,
    expiresAt,
    expiresIn,
    createdAt,
  };
}

function deriveExpiry(b) {
  const seconds =
    b?.expires_in ??
    b?.expirationSeconds ??
    b?.pix?.expires_in ??
    b?.pix?.expirationSeconds ??
    null;
  if (Number.isFinite(seconds)) {
    const expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
    return { expiresAt, expiresIn: Math.max(0, Math.floor(seconds)) };
  }
  const dateOnly = b?.pix?.expirationDate;
  if (typeof dateOnly === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
    const expiresAtISO = `${dateOnly}T23:59:59-03:00`;
    const expiresMs = Date.parse(expiresAtISO);
    if (!Number.isNaN(expiresMs)) {
      const nowMs = Date.now();
      const expiresIn = Math.max(0, Math.floor((expiresMs - nowMs) / 1000));
      return { expiresAt: new Date(expiresMs).toISOString(), expiresIn };
    }
  }
  if (b?.createdAt && b?.expiresIn) {
    const created = Date.parse(b.createdAt);
    if (!Number.isNaN(created)) {
      const expMs = created + Number(b.expiresIn) * 1000;
      return {
        expiresAt: new Date(expMs).toISOString(),
        expiresIn: Math.max(0, Math.floor((expMs - Date.now()) / 1000)),
      };
    }
  }
  return { expiresAt: null, expiresIn: null };
}

function extractCauseId(externalRef) {
  if (typeof externalRef !== "string") return null;
  const m = externalRef.match(/^donation-([^-\s]+)-\d+$/);
  return m ? m[1] : null;
}

async function incrementCausaArrecadado(jsonPath, causeId, incrementReais) {
  const raw = await fs.readFile(jsonPath, "utf-8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Arquivo inválido: ${jsonPath}`);
  }

  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.causas)
    ? data.causas
    : null;
  if (!list)
    throw new Error(
      "Estrutura de causas não suportada. Esperado array ou { causas: [] }."
    );

  const idx = list.findIndex((c) => String(c.id) === String(causeId));
  if (idx === -1) {
    console.warn(`[increment] causa não encontrada: ${causeId}`);
    return;
  }

  const atual = Number(list[idx].arrecadado || 0);
  const novo = Number((atual + incrementReais).toFixed(2));

  list[idx].arrecadado = novo;

  const out = Array.isArray(data) ? list : { ...data, causas: list };
  await fs.mkdir(path.dirname(jsonPath), { recursive: true });
  await fs.writeFile(jsonPath, JSON.stringify(out, null, 2), "utf-8");
}

async function ensureFile(p, defaultContent = "") {
  try {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.access(p);
  } catch {
    await fs.writeFile(p, defaultContent, "utf-8");
  }
}

async function readProcessed(p) {
  const raw = await fs.readFile(p, "utf-8").catch(() => '{"processed":[]}');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { processed: [] };
  }
  return new Set((data?.processed || []).map((x) => String(x)));
}

async function writeProcessed(p, set) {
  const arr = Array.from(set);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify({ processed: arr }, null, 2), "utf-8");
}

/* ----------- static frontend ----------- */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const distPath = path.resolve(__dirname, "../campanhas/dist");
app.use(express.static(distPath));

app.get(/^\/(?!api).*/, (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
