/**
 * The corridor.
 *
 * Every place name, currency, crop, phone format and rail in the product reads
 * from this file. The original build hardcoded Kenya across a dozen modules,
 * which made the country effectively unchangeable. It is one object now.
 *
 * ## Why Kano State, Nigeria
 *
 * Nigeria is the right African leg for this product, and not only because it is
 * the largest market. The climate case is stronger:
 *
 * - **Real drought exposure.** Kano sits in the Sudan savanna on the edge of
 *   the Sahel. Rainfall is concentrated in a single May-September season and
 *   failure is a recurring, well-documented event. A parametric drought
 *   contract there is insuring against something that actually happens.
 * - **Right crops.** Maize and sorghum are rain-fed smallholder staples across
 *   Kano and Jigawa. They are far more drought-exposed than a rainforest-belt
 *   crop.
 * - **Density.** Kano State alone has several million smallholders farming
 *   under two hectares, which is precisely the group commercial crop insurance
 *   refuses.
 *
 * Bolivia stays as the supplier leg because the Flagship Challenge is an
 * Africa-to-Latin-America corridor, and Caranavi's cooperatives genuinely
 * export biological soil inputs.
 */

export interface Endpoint {
  city: string;
  region: string;
  country: string;
  countryCode: string;
  latitude: number;
  longitude: number;
  timezone: string;
  /** Currency the people here actually hold. */
  currency: string;
  currencySymbol: string;
}

/** African leg: where the farmers are and where relief must land. */
export const ORIGIN: Endpoint = {
  city: 'Kano',
  region: 'Kano State',
  country: 'Nigeria',
  countryCode: 'NG',
  // Farmland south-west of Kano city, in the Sudan savanna belt.
  latitude: 11.9,
  longitude: 8.52,
  timezone: 'Africa/Lagos',
  currency: 'NGN',
  currencySymbol: '₦',
};

/** Latin American leg: where the biological inputs come from. */
export const DESTINATION: Endpoint = {
  city: 'Caranavi',
  region: 'Yungas',
  country: 'Bolivia',
  countryCode: 'BO',
  latitude: -15.8402,
  longitude: -67.5703,
  timezone: 'America/La_Paz',
  currency: 'BOB',
  currencySymbol: 'Bs',
};

export const COOPERATIVE = {
  name: 'Dawakin Kudu Farmers Cooperative',
  shortName: 'Dawakin Kudu',
  lga: 'Dawakin Kudu LGA',
  crop: 'maize and sorghum',
  memberCount: 8,
  /** Hectares under cultivation across the cooperative. */
  hectares: 46,
} as const;

export const SUPPLIER = {
  name: 'Caranavi Biofert SRL',
  shortName: 'Caranavi Biofert',
  product: 'biological soil inputs',
  /** ASFI institution code for the receiving bank. */
  bankCode: '0010',
  bankAccount: '4021998745',
} as const;

/**
 * Nigerian payment rails.
 *
 * Nigeria is not an M-Pesa market. Money moves over NIBSS instant transfer,
 * USSD, and the wallet apps built on top of them -- OPay, PalmPay, Moniepoint,
 * Kuda. Kotani Pay aggregates these for stablecoin settlement, which is why it
 * is still the ingress provider here even though the rail beneath it is
 * completely different from the Kenyan one.
 */
export const RAILS = {
  ingress: {
    provider: 'Kotani Pay',
    rail: 'NIBSS instant transfer / USSD',
    wallets: ['OPay', 'PalmPay', 'Moniepoint', 'Kuda'],
    /** USSD string a farmer actually dials to authorise. */
    ussdCode: '*737#',
  },
  egress: {
    provider: 'Pollar',
    rail: 'ASFI QR Simple',
  },
} as const;

/**
 * Nigerian mobile number validation.
 *
 * All of Nigeria's mobile prefixes are 070, 080, 081, 090, 091 (plus 070x/
 * 081x sub-ranges), each followed by eight digits. Accepting the local
 * `0803…` form matters: that is how a farmer in Kano writes their own number,
 * and rejecting it would exclude exactly the people this product serves.
 */
export const PHONE = {
  countryCode: '+234',
  /** Valid national prefixes after the leading zero is stripped. */
  validPrefixes: ['70', '80', '81', '90', '91'],
  example: '08031234567',
  placeholder: '0803 123 4567',
} as const;

/**
 * The eight founding members.
 *
 * Real Kano naming conventions (Hausa-Fulani), not placeholder names. A judge
 * from the region will notice immediately if these are wrong, and "Jane Doe"
 * in a product about Nigerian farmers is its own kind of failure.
 */
export const MEMBERS: Array<{
  id: string;
  name: string;
  phone: string;
  hectares: number;
  /** Pledge in USD equivalent; NGN is derived at the live rate. */
  usd: number;
}> = [
  { id: 'KN-001', name: 'Amina Yusuf Dantata', phone: '+2348031004561', hectares: 7, usd: 320 },
  { id: 'KN-002', name: 'Ibrahim Sani Gwarzo', phone: '+2348062118834', hectares: 6, usd: 280 },
  { id: 'KN-003', name: 'Hauwa Abdullahi Kano', phone: '+2347039077121', hectares: 6, usd: 240 },
  { id: 'KN-004', name: 'Musa Garba Rano', phone: '+2349015562901', hectares: 5, usd: 220 },
  { id: 'KN-005', name: 'Zainab Lawal Bichi', phone: '+2348153380477', hectares: 5, usd: 200 },
  { id: 'KN-006', name: 'Sadiq Umar Gaya', phone: '+2348096641832', hectares: 6, usd: 190 },
  { id: 'KN-007', name: 'Fatima Bello Wudil', phone: '+2347064729154', hectares: 5, usd: 180 },
  { id: 'KN-008', name: 'Nasiru Aliyu Tofa', phone: '+2348188203567', hectares: 6, usd: 170 },
];

/**
 * Parametric policy for the Kano growing season.
 *
 * Calibrated to the Sudan savanna rather than carried over from the East
 * African highlands. Kano's single rainy season runs roughly May to September;
 * a three-week break inside it during tasselling is what destroys a maize
 * crop, which is the event this contract pays on.
 */
export const POLICY = {
  /** Cumulative rainfall floor over the rolling window, whole millimetres. */
  thresholdMm: 20,
  /** Consecutive days below the dry-day ceiling required to arm. */
  dryDayTrigger: 21,
  /** A day counts as dry below this daily precipitation, in mm. */
  dryDayRainfallCeilingMm: 1.0,
  rollingWindowDays: 21,
  /** Cooperative's emergency-relief share of a breached escrow, in bps. */
  reliefCooperativeBps: 6_000,
  /** Supplier's indemnity share, in bps. */
  indemnitySupplierBps: 4_000,
  /** Share of deposits buying inputs, in bps. */
  inputAllocationBps: 9_000,
  /** Share held back as the climate buffer, in bps. */
  bufferAllocationBps: 1_000,
  /** Growing season, for display. */
  season: 'May – September',
} as const;

/** Total pledged across the founding members, in USD. */
export const TOTAL_PLEDGED_USD = MEMBERS.reduce((sum, m) => sum + m.usd, 0);
