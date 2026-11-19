# Danger-sign list and sources

ASHA Vaani escalates **only** the signs below. When one is heard, the agent immediately says, in the ASHA's language,
"Danger sign: … Please refer to the PHC now. I have flagged the record." It gives **no diagnosis, no treatment and no
dosage**. The list lives in [`public/js/nlu/danger.js`](public/js/nlu/danger.js), one entry per sign, each with its source tag.

Because the track rules count a missed danger sign double, the matcher favours recall. Any mention that isn't negated is
flagged. A sign is skipped only when it is clearly denied ("bleeding nahi hai", "no fever"). Phrases like "bleeding ruk
nahi rahi" (bleeding won't stop) and "bukhar nahi utar raha" (fever won't come down) still count as present.

## Sources

| Tag | Document |
|---|---|
| **MCP** | Ministry of Health & Family Welfare (MoHFW), *Mother and Child Protection Card* (joint MoHFW–MoWCD card, 2018 edition): "Danger signs during pregnancy" and "after delivery" panels |
| **ANC** | MoHFW, *Guidelines for Antenatal Care and Skilled Attendance at Birth by ANMs/LHVs/SNs* (2010) |
| **HBNC** | MoHFW, *Home Based Newborn Care Operational Guidelines* (Revised 2014): https://hbnc-hbyc.mohfw.gov.in/documents/hbnc |
| **IMNCI** | MoHFW / WHO, *Integrated Management of Neonatal and Childhood Illness*, sick young infant (0–2 months) module |
| **UIP** | MoHFW, *National Immunization Schedule* (Universal Immunization Programme), used for "vaccines due" |

## Signs (spoken phrases)

| id | Sign | Applies to | Source |
|---|---|---|---|
| bleeding | Vaginal bleeding in pregnancy / heavy bleeding after delivery / bleeding in newborn | pregnancy, postpartum, newborn | MCP, ANC, HBNC |
| convulsions | Fits / convulsions | all | MCP, HBNC, IMNCI |
| severe_headache_vision | Severe headache or blurred vision | pregnancy, postpartum | MCP, ANC |
| fever | Fever (any mention), or a measured temperature ≥ 38 °C (mother) / ≥ 37.5 °C (newborn) | all | MCP, HBNC, IMNCI |
| hypothermia | Newborn cold to touch, or temperature < 35.5 °C | newborn | HBNC, IMNCI |
| severe_abdominal_pain | Severe abdominal pain | pregnancy, postpartum | MCP, ANC |
| swelling | Swelling of face / hands | pregnancy, postpartum | MCP, ANC |
| reduced_fetal_movement | Baby's movements reduced or absent | pregnancy | MCP, ANC |
| water_leak | Leaking of water / membranes ruptured before labour | pregnancy | MCP, ANC |
| breathing_difficulty | Difficulty breathing; newborn fast breathing (≥ 60/min) or chest indrawing | all | MCP, HBNC, IMNCI |
| not_feeding | Newborn not feeding / unable to suck | newborn | HBNC, IMNCI |
| lethargy | Lethargic / unconscious | all | HBNC, IMNCI |
| jaundice | Jaundice: yellow palms / soles | newborn | HBNC, IMNCI |
| umbilical_infection | Umbilicus red or with pus | newborn | HBNC, IMNCI |
| skin_pustules | Skin pustules | newborn | HBNC, IMNCI |
| vomiting_everything | Vomits everything | newborn, pregnancy | IMNCI |
| foul_discharge | Foul-smelling vaginal discharge | postpartum | MCP |

## Numeric rules (from spoken vitals)

| id | Rule | Source |
|---|---|---|
| high_bp | BP ≥ 140 systolic or ≥ 90 diastolic | MCP, ANC |
| severe_anaemia | Hb < 7 g/dL | MCP, ANC |
| fever / hypothermia / breathing_difficulty | Temperature and breathing-rate cut-offs above | HBNC, IMNCI |
| very_low_birth_weight | Newborn weight < 1.8 kg | HBNC |

> **Before using this in any real setting**, a public-health professional must check every threshold against the current
> official documents. This list is for a hackathon demo with synthetic beneficiaries only.
