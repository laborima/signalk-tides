declare module 'tz-lookup' {
  /**
   * Returns the IANA timezone identifier for the given coordinates.
   * Throws if latitude/longitude are invalid.
   */
  export default function tzlookup(latitude: number, longitude: number): string;
}
