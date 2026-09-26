/**
 * Responsibility: register the `agent` reporter with Stryker and expose its
 * option schema. Stryker loads this file through the `plugins` option and
 * reads `strykerPlugins` and `strykerValidationSchema` off it.
 * Boundary: this file holds no reporter logic; see `agent-reporter.ts`.
 */

import fs from 'node:fs';

import { declareClassPlugin, PluginKind } from '@stryker-mutator/api/plugin';

import { AgentReporter } from './agent-reporter.ts';

export const strykerPlugins = [
  declareClassPlugin(PluginKind.Reporter, 'agent', AgentReporter),
];

export const strykerValidationSchema: typeof import('../schema/agent-reporter-options.json') =
  JSON.parse(
    fs.readFileSync(
      new URL('../schema/agent-reporter-options.json', import.meta.url),
      'utf-8',
    ),
  );
