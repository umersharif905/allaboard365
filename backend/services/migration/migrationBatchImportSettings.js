'use strict';

function parseBatchSummaryJson(summaryJson) {
  if (!summaryJson) return {};
  try {
    return typeof summaryJson === 'string' ? JSON.parse(summaryJson) : summaryJson;
  } catch (_) {
    return {};
  }
}

function getBatchImportSettings(batch) {
  return parseBatchSummaryJson(batch?.SummaryJson).importSettings || {};
}

function mergeBatchImportSettings(summaryJson, importSettingsPatch) {
  const current = parseBatchSummaryJson(summaryJson);
  return JSON.stringify({
    ...current,
    importSettings: {
      ...(current.importSettings || {}),
      ...importSettingsPatch
    }
  });
}

function mergeBatchFetchProgress(summaryJson, fetchProgressPatch) {
  const current = parseBatchSummaryJson(summaryJson);
  return JSON.stringify({
    ...current,
    fetchProgress: {
      ...(current.fetchProgress || {}),
      ...fetchProgressPatch
    }
  });
}

function preserveImportSettingsInSummary(summaryJson, applySummary) {
  const current = parseBatchSummaryJson(summaryJson);
  if (!current.importSettings) return JSON.stringify(applySummary);
  return JSON.stringify({
    ...applySummary,
    importSettings: current.importSettings
  });
}

module.exports = {
  parseBatchSummaryJson,
  getBatchImportSettings,
  mergeBatchImportSettings,
  mergeBatchFetchProgress,
  preserveImportSettingsInSummary
};
