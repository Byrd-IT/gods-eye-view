// Every feed group's fixtures, in one list for the tests and the gate.
import { aircraftFixtures } from './aircraft.mjs';
import { bikeshareFixtures } from './bikeshare.mjs';
import { transitFixtures } from './transit.mjs';

export const FIXTURES = Object.freeze([
  ...aircraftFixtures,
  ...bikeshareFixtures,
  ...transitFixtures,
]);
