import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { healthCheck, compatibilityCheck, compatibilitySnapshot, _isReconnectText } from '../src/core/health.js';

function depsFor(state) {
  return {
    getClient: async () => ({}),
    getTargetInfo: async () => ({
      url: 'https://www.tradingview.com/chart/test/?symbol=SECRET',
      title: 'TradingView',
    }),
    evaluate: async (expression) => {
      assert.match(expression, /ChartApiInstance/);
      return state;
    },
  };
}

function liveProbeDeps({
  chartApiInstance,
  sessionConnected = true,
  sessionId = 'cs_test',
  sessionState = 2,
  browserOnline = true,
  reconnectText = '',
  seriesStatus = 3,
  seriesStatusError = false,
} = {}) {
  const series = {
    bars: () => ({}),
    status: () => seriesStatus,
    isStatusError: () => seriesStatusError,
  };

  const inner = {
    dataSources: () => [],
  };

  const model = {
    model: () => inner,
    mainSeries: () => series,
  };

  const chartSession = {
    _sessionId: sessionId,
    _state: sessionState,
  };

  if (sessionConnected !== null) {
    chartSession._isConnected = {
      value: () => sessionConnected,
    };
  }

  const widget = {
    _chartSession: chartSession,
    model: () => model,
  };

  const chart = {
    _chartWidget: widget,
    symbol: () => 'NASDAQ:NVDA',
    resolution: () => '1D',
    chartType: () => 1,
    getAllStudies: () => [],
  };

  const window = {
    location: {
      href: 'https://www.tradingview.com/chart/test/?symbol=SECRET',
    },
    TradingViewApi: {
      _activeChartWidgetWV: {
        value: () => chart,
      },
    },
  };

  if (chartApiInstance !== undefined) {
    window.ChartApiInstance = chartApiInstance;
  }

  const document = {
    title: 'TradingView',
    querySelectorAll: () => [],
    body: {
      innerText: reconnectText,
    },
  };

  const navigator = {
    onLine: browserOnline,
    userAgent: 'TVDesktop/3.4.0.8149',
  };

  return {
    getClient: async () => ({}),
    getTargetInfo: async () => ({
      url: 'https://www.tradingview.com/chart/test/?symbol=SECRET',
      title: 'TradingView',
    }),
    evaluate: async (expression) => (
      new Function(
        'window',
        'document',
        'navigator',
        `return (${expression});`,
      )(window, document, navigator)
    ),
  };
}

test('healthCheck reports feed and compatibility health without leaking target query parameters', async () => {
  const result = await healthCheck({
    _deps: depsFor({
      symbol: 'NASDAQ:NVDA',
      resolution: '1D',
      chartType: 1,
      apiAvailable: true,
      datafeed: { state: 'connected', connected: true },
      compatibility: { compatible: true, checks: { active_chart: true }, missing: [], desktop_version: '3.3.0' },
    }),
  });
  assert.equal(result.healthy, true);
  assert.equal(result.status, 'healthy');
  assert.equal(result.target_url, 'https://www.tradingview.com/chart/');
  assert.equal(result.datafeed.state, 'connected');
});

test('health probe uses the legacy ChartApiInstance signal when it is available', async () => {
  const result = await healthCheck({
    _deps: liveProbeDeps({
      chartApiInstance: {
        connected: () => true,
      },
      sessionConnected: false,
    }),
  });

  assert.equal(result.healthy, true);
  assert.equal(result.datafeed.state, 'connected');
  assert.equal(result.datafeed.connected, true);
  assert.equal(result.datafeed.connection_source, 'chart_api_instance');
});

test('health probe falls back to the active chart session on Desktop 3.4', async () => {
  const result = await healthCheck({
    _deps: liveProbeDeps({
      sessionConnected: true,
      sessionId: 'cs_live',
      sessionState: 2,
    }),
  });

  assert.equal(result.healthy, true);
  assert.equal(result.status, 'healthy');
  assert.equal(result.datafeed.state, 'connected');
  assert.equal(result.datafeed.connected, true);
  assert.equal(result.datafeed.connection_source, 'active_chart_session');
});

test('active chart session fallback reports an explicit disconnect', async () => {
  const result = await healthCheck({
    _deps: liveProbeDeps({
      sessionConnected: false,
      sessionId: 'cs_live',
      sessionState: 2,
    }),
  });

  assert.equal(result.healthy, false);
  assert.equal(result.datafeed.state, 'disconnected');
  assert.equal(result.datafeed.connected, false);
  assert.equal(result.datafeed.connection_source, 'active_chart_session');
});

test('health probe remains unknown when neither global nor session evidence is explicit', async () => {
  const result = await healthCheck({
    _deps: liveProbeDeps({
      sessionConnected: null,
    }),
  });

  assert.equal(result.healthy, false);
  assert.equal(result.datafeed.state, 'unknown');
  assert.equal(result.datafeed.connected, null);
  assert.equal(result.datafeed.connection_source, null);
});

test('explicit global disconnect is never overridden by a connected pane fallback', async () => {
  const result = await healthCheck({
    _deps: liveProbeDeps({
      chartApiInstance: {
        connected: () => false,
      },
      sessionConnected: true,
    }),
  });

  assert.equal(result.healthy, false);
  assert.equal(result.datafeed.state, 'disconnected');
  assert.equal(result.datafeed.connected, false);
  assert.equal(result.datafeed.connection_source, 'chart_api_instance');
});

test('reconnect evidence overrides a connected active chart session', async () => {
  const result = await healthCheck({
    _deps: liveProbeDeps({
      sessionConnected: true,
      reconnectText: 'Reconnecting...',
    }),
  });

  assert.equal(result.healthy, false);
  assert.equal(result.datafeed.state, 'reconnecting');
});

test('series errors override a connected active chart session', async () => {
  const result = await healthCheck({
    _deps: liveProbeDeps({
      sessionConnected: true,
      seriesStatusError: true,
    }),
  });

  assert.equal(result.healthy, false);
  assert.equal(result.datafeed.state, 'series_error');
});

test('browser offline state overrides a connected active chart session', async () => {
  const result = await healthCheck({
    _deps: liveProbeDeps({
      sessionConnected: true,
      browserOnline: false,
    }),
  });

  assert.equal(result.healthy, false);
  assert.equal(result.datafeed.state, 'offline');
});

test('healthCheck is degraded and actionable while TradingView is reconnecting', async () => {
  const result = await healthCheck({
    _deps: depsFor({
      symbol: 'NASDAQ:NVDA',
      resolution: '1D',
      chartType: 1,
      apiAvailable: true,
      datafeed: { state: 'reconnecting', connected: false, reconnect_indicator: true },
      compatibility: { compatible: true, checks: {}, missing: [], desktop_version: '3.3.0' },
    }),
  });
  assert.equal(result.healthy, false);
  assert.equal(result.status, 'degraded');
  assert.match(result.warnings.join(' '), /reconnecting/);
});

test('compatibilityCheck reports missing critical capabilities', async () => {
  const result = await compatibilityCheck({
    _deps: depsFor({
      datafeed: { connected: null },
      compatibility: {
        compatible: false,
        checks: { main_series_bars: false },
        missing: ['main_series_bars'],
        desktop_version: '3.4.0',
      },
    }),
  });
  assert.equal(result.compatible, false);
  assert.deepEqual(result.missing, ['main_series_bars']);
  assert.equal(result.datafeed_probe_available, false);
});

test('reconnect banner detection covers common localized TradingView messages', () => {
  for (const message of ['Reconnecting...', 'Sin conexión', 'Verbindung verloren', 'Hors ligne', 'Sem conexão', 'กำลังเชื่อมต่อใหม่', '再接続中']) {
    assert.equal(_isReconnectText(message), true, message);
  }
  assert.equal(_isReconnectText('Connection settings'), false);
});

test('compatibility snapshots record once and report informational surface drift', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tvcontrol-compat-'));
  let signature = 'aaaa1111';
  const deps = {
    dir,
    compatibilityCheck: async () => ({ compatible: true, checks: { active_chart: true }, missing: [], desktop_version: '3.3.0' }),
    discover: async () => ({ apis: { chartApi: { available: true, methodCount: 10, method_signature: signature } } }),
  };
  try {
    const recorded = await compatibilitySnapshot({ action: 'record', _deps: deps });
    assert.equal(recorded.recorded, true);
    const unchanged = await compatibilitySnapshot({ action: 'compare', _deps: deps });
    assert.equal(unchanged.baseline_found, true);
    assert.deepEqual(unchanged.surface_drift, []);
    signature = 'bbbb2222';
    const drifted = await compatibilitySnapshot({ action: 'compare', _deps: deps });
    assert.equal(drifted.surface_drift.length, 1);
    const preserved = await compatibilitySnapshot({ action: 'record', _deps: deps });
    assert.equal(preserved.recorded, false, 'existing baseline is immutable without overwrite');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compatibility snapshot storage is bounded across Desktop versions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tvcontrol-compat-bounded-'));
  let version = 0;
  const deps = {
    dir,
    compatibilityCheck: async () => ({ compatible: true, checks: {}, missing: [], desktop_version: `3.3.${version}` }),
    discover: async () => ({ apis: {} }),
  };
  try {
    for (version = 0; version < 23; version++) {
      assert.equal((await compatibilitySnapshot({ action: 'record', _deps: deps })).recorded, true);
    }
    const listed = await compatibilitySnapshot({ action: 'list', _deps: deps });
    assert.equal(listed.count, 20);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
