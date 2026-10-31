// Every feed group's fixtures, in one list for the tests and the gate.
import { aircraftFixtures } from './aircraft.mjs';
import { satelliteFixtures } from './satellites.mjs';

export const FIXTURES = Object.freeze([
  ...aircraftFixtures,
  ...satelliteFixtures,
]);
