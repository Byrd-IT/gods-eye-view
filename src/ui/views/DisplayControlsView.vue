<script setup>
import { t } from '../../i18n/index.js';
import { useDisplayStore } from '../stores/display.js';
import DisplayPanel from './panels/DisplayPanel.vue';
import UiButton from '../kit/UiButton.vue';

const display = useDisplayStore();

// Byrd-IT: cleanViewEye.sync() also writes the eye's label/title imperatively.
// Derive the same wording from the body class here so a re-render (locale
// change) never patches the off-state text back while clean view is on.
function eyeLabel() {
  const on = globalThis.document?.body?.classList.contains('ui-clean-view');
  return on
    ? t('Exit clean view: show the controls')
    : t('Clean view: hide the controls');
}
function eyeTitle() {
  return t('{label} (V)', { label: eyeLabel() });
}
</script>

<template>
  <DisplayPanel />
  <UiButton id="clean-view-exit" @click="display.act('exitCleanView')" :title="t('Return UI controls')">{{ t('EXIT CLEAN VIEW') }}</UiButton>
  <!-- Byrd-IT: the corner eye mirrors clean view (ui/cleanViewEye.js). -->
  <!-- aria-pressed is kept in step by bindCleanViewEye (sync); the kit button starts it at false. -->
  <UiButton id="clean-view-eye" :pressed="false" @click="display.act('toggleCleanView')" :aria-label="eyeLabel()" :title="eyeTitle()">
    <span class="clean-view-eye-icon" aria-hidden="true"></span>
  </UiButton>
</template>
