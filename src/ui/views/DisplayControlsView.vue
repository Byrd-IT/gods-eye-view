<script setup>
import { t } from '../../i18n/index.js';
import { useDisplayStore } from '../stores/display.js';
import DisplayPanel from './panels/DisplayPanel.vue';

const display = useDisplayStore();
</script>

<template>
  <DisplayPanel />
  <button id="clean-view-exit" @click="display.act('exitCleanView')" :title="t('Return UI controls')">{{ t('EXIT CLEAN VIEW') }}</button>
  <!-- Byrd-IT: the corner eye mirrors clean view (ui/cleanViewEye.js). -->
  <button id="clean-view-eye" type="button" aria-pressed="false" @click="display.act('toggleCleanView')" :aria-label="t('Clean view: hide the controls')" :title="t('Clean view: hide the controls (V)')">
    <span class="clean-view-eye-icon" aria-hidden="true"></span>
  </button>
</template>
