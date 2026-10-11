// Shared real-board registry for the project and Cypress benchmarks.
const CIAA = 'benchmark/ciaa-Hardware/PCB';
const PPC = 'benchmark/powerpc-laptop-mobo/KiCAD/openPPCnotebook';
export const KICAD_CASES = [
  ['z3r0', `${CIAA}/Z3R0/ciaa-z3r0.kicad_pcb`],
  ['pico', `${CIAA}/pico/picociaa.kicad_pcb`],
  ['edk', `${CIAA}/EDU-INTEL/edk.kicad_pcb`],
  ['edu-fpga', `${CIAA}/EDU-FPGA/Schematic/FPGA para todos.kicad_pcb`],
  ['fsl-mini', `${CIAA}/FSL-MINI/CIAA_FSL_MINI.kicad_pcb`],
  ['edu-k60', `${CIAA}/EDU-FSL/EDU_CIAA_K60/EDU_CIAA_K60.kicad_pcb`],
  ['edu-nxp', `${CIAA}/EDU-NXP/edu-ciaa-nxp.kicad_pcb`],
  ['safety', `${CIAA}/Safety/CIAA_Safety_VTI_1.0.kicad_pcb`],
  ['pic', `${CIAA}/PIC/ciaa-pic.kicad_pcb`],
  ['nxp', `${CIAA}/NXP/ciaa-nxp.kicad_pcb`],
  ['rx', `${CIAA}/RX/hw/ciaa-rx.kicad_pcb`],
  ['k60', `${CIAA}/FSL/CIAA_K60/CIAA_K60.kicad_pcb`],
  ['acc', `${CIAA}/ACC/CIAA_ACC/ciaa_acc.kicad_pcb`],
  ['ppc-n3', `${PPC}/Mas100n3 ACB_0001_2.kicad_pcb`],
  ['ppc-n1', `${PPC}/Mas100n1 ACUBE_PORTABILE R_0.kicad_pcb`],
];
