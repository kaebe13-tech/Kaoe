export type TraitId = 'industrious' | 'curious' | 'sociable' | 'timid' | 'brave' | 'glutton' | 'sleepy' | 'kind';

export interface TraitDef {
  label: string;
  desc: string;
  conflicts?: TraitId[];
}

export const TRAITS: Record<TraitId, TraitDef> = {
  industrious: { label: 'Industrious', desc: 'Happiest when working; gathers and builds more than most.', conflicts: ['sleepy'] },
  curious: { label: 'Curious', desc: 'Wanders off to explore and discovers new places.' },
  sociable: { label: 'Sociable', desc: 'Seeks company often and shares what they know.' },
  timid: { label: 'Timid', desc: 'Easily frightened; prefers to stay near camp after dark.', conflicts: ['brave'] },
  brave: { label: 'Brave', desc: 'Keeps a cool head in danger and rushes to help others.', conflicts: ['timid'] },
  glutton: { label: 'Big appetite', desc: 'Gets hungry quickly and likes to carry snacks.' },
  sleepy: { label: 'Sleepyhead', desc: 'Tires easily and loves a long sleep.', conflicts: ['industrious'] },
  kind: { label: 'Kind-hearted', desc: 'Shares food and tends to anyone who is hurt.' },
};

export const TRAIT_IDS = Object.keys(TRAITS) as TraitId[];
