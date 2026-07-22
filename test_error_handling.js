import { callHermes } from './dist/hermes/client.js';
import { HermesResponseSchema } from './dist/hermes/schema.js';
import axios from 'axios';
import assert from 'assert';

// We intercept axios globally
const originalPost = axios.post;

async function runTests() {
  console.log("=== EJECUTANDO PRUEBAS DE ERROR TÉCNICO (GATEWAY) ===");
  
  let currentMockResponse = null;
  let currentMockStatus = 200;

  axios.post = async (url, data, config) => {
    // If the mock responds with 502
    if (config.validateStatus) {
      if (!config.validateStatus(currentMockStatus)) {
        const err = new Error("Request failed with status code " + currentMockStatus);
        err.isAxiosError = true;
        err.response = { status: currentMockStatus, data: currentMockResponse, headers: {} };
        err.code = 'ERR_BAD_REQUEST';
        throw err;
      }
    } else {
      if (currentMockStatus >= 300) {
        const err = new Error("Request failed with status code " + currentMockStatus);
        err.isAxiosError = true;
        err.response = { status: currentMockStatus, data: currentMockResponse, headers: {} };
        err.code = 'ERR_BAD_REQUEST';
        throw err;
      }
    }
    
    return {
      status: currentMockStatus,
      data: currentMockResponse,
      headers: {}
    };
  };

  try {
    console.log("\nCASO A: Hermes devuelve 502 con JSON de provider_timeout");
    currentMockStatus = 502;
    currentMockResponse = {
      "ok": false,
      "route": "error",
      "intent": "provider_timeout",
      "recoverable": true,
      "error_code": "HERMES_TIMEOUT",
      "requires_handoff": false,
      "safe_to_send": false,
      "response_sent": false
    };

    const resA = await callHermes({ patient: { is_new: true }, message: { text: 'test' } }, 'trace_a');
    console.log("Resultado A:", resA);
    assert.strictEqual(resA.route, 'error');
    assert.strictEqual(resA.error_code, 'HERMES_TIMEOUT');
    assert.strictEqual(resA.recoverable, true);
    assert.strictEqual(resA.handoff_required, false);
    assert.strictEqual(resA.safe_to_send, false);
    console.log("-> ✅ Caso A pasó correctamente");

  } catch (err) {
    console.error("❌ Falló la prueba:", err.message);
    process.exit(1);
  } finally {
    axios.post = originalPost;
  }
}

runTests();
