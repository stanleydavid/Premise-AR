import 'server-only';
import { z } from 'zod';
import { query } from '@/lib/db/pg';
import { licenceStatus } from '@/lib/domain/licence-status';

export const NearbyQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().int().min(10).max(500).default(300),
});

export type NearbyPremise = {
  id: string; trade_name: string; registered_name: string | null; address: string | null; floor: number;
  lat: number; lng: number; distance_m: number; location_source: string;
  licence: null | {
    id: string; licence_no: string; type_code: string; status: string; valid_until: string; conditions: string[];
    outstanding_compound_sen: number; display: ReturnType<typeof licenceStatus>;
  };
  last_inspection: null | { observed_at: string; outcome: string };
};

type Row = {
  id: string; trade_name: string; registered_name: string | null; address: string | null; floor: number;
  lat: number; lng: number; distance_m: number; location_source: string;
  licence_id: string | null; licence_no: string | null; licence_type_code: string | null; licence_status: string | null;
  valid_until: string | null; conditions: string[] | null; outstanding_compound_sen: string | null;
  last_observed_at: string | null; last_outcome: string | null;
};

/** Premises within `radius` metres, nearest first, with their current licence and last inspection. */
export async function nearbyPremises(input: z.infer<typeof NearbyQuery>): Promise<NearbyPremise[]> {
  const rows = await query<Row>(
    `with here as (select st_setsrid(st_makepoint($2, $1), 4326)::geography g)
     select p.id, p.trade_name, p.registered_name, p.address, p.floor, p.location_source,
            st_y(p.location::geometry) lat, st_x(p.location::geometry) lng,
            round(st_distance(p.location, here.g)::numeric, 1)::float8 distance_m,
            l.id licence_id, l.licence_no, l.licence_type_code, l.status licence_status,
            to_char(l.valid_until, 'YYYY-MM-DD') valid_until, l.conditions, l.outstanding_compound_sen::text,
            li.observed_at last_observed_at, li.outcome last_outcome
       from premises p cross join here
       left join lateral (select * from licences l where l.premise_id = p.id order by l.valid_until desc limit 1) l on true
       left join lateral (select i.observed_at, i.outcome from inspections i where i.premise_id = p.id
                           order by i.observed_at desc limit 1) li on true
      where st_dwithin(p.location, here.g, $3)
      order by distance_m
      limit 300`,
    [input.lat, input.lng, input.radius]);
  return rows.map((r) => ({
    id: r.id, trade_name: r.trade_name, registered_name: r.registered_name, address: r.address, floor: r.floor,
    lat: r.lat, lng: r.lng, distance_m: r.distance_m, location_source: r.location_source,
    licence: r.licence_id ? {
      id: r.licence_id, licence_no: r.licence_no!, type_code: r.licence_type_code!, status: r.licence_status!,
      valid_until: r.valid_until!, conditions: r.conditions ?? [], outstanding_compound_sen: Number(r.outstanding_compound_sen ?? 0),
      display: licenceStatus({ status: r.licence_status!, valid_until: r.valid_until! }),
    } : null,
    last_inspection: r.last_observed_at ? { observed_at: r.last_observed_at, outcome: r.last_outcome! } : null,
  }));
}

export type RuleSet = {
  types: Array<{ code: string; name: string }>;
  rules: Array<{ id: string; type_code: string | null; text: string; kind: 'visual' | 'manual'; is_example: boolean }>;
};

export async function ruleSet(): Promise<RuleSet> {
  const [types, rules] = await Promise.all([
    query<{ code: string; name: string }>('select code, name from licence_types where active order by name'),
    query<RuleSet['rules'][number]>(
      `select id, licence_type_code type_code, text, kind, is_example from compliance_rules where active
        order by licence_type_code nulls first, sort, id`),
  ]);
  return { types, rules };
}

/** The checklist that applies to a licence type: the common rules, then the type's own. */
export function applicableRules(rules: RuleSet['rules'], typeCode: string | null) {
  return rules.filter((r) => r.type_code === null || r.type_code === typeCode);
}
