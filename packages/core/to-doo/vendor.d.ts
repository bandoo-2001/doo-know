declare module 'lunar-javascript' {
  export const Lunar: {
    fromYmd(
      year: number,
      month: number,
      day: number,
    ): { getSolar(): { getYear(): number; getMonth(): number; getDay(): number } };
  };
  const library: { Lunar: typeof Lunar };
  export default library;
}
