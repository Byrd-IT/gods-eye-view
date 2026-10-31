// Every feed group's fixtures, in one list for the tests and the gate.
import { aircraftFixtures } from './aircraft.mjs';
import { vesselsFixtures } from './vessels.mjs';

export const FIXTURES = Object.freeze([
  ...aircraftFixtures,
  ...vesselsFixtures,
]);
