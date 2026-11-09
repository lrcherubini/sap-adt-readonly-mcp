// Synthetic, shaped like a real checkout: a customer convention, with the value split
// across two lines and a comment between the annotations.
define view entity ZC_DemoRosterMonitor as select from ZI_DemoRosterMonitor
{
      // Contextual label, not redundancy: STCD2 is the generic field for tax number 2,
      // and here it always carries a person's tax id.
      //
      // @ObjectModel.text.element here (and not a new association): EmployeeName is already a
      // plain element of this view, same row as the tax id (LEFT OUTER JOIN on
      // ZI_DemoRosterMonitor) -- same pattern as SystemId/SystemText below. Null when there
      // is no snapshot in ZDEMO_TBL_0067 (see SnapshotCriticality): Fiori then shows the id only.
      @EndUserText.label: 'Tax ID'
      @Search.defaultSearchElement: true
      @ObjectModel.text.element: ['EmployeeName']
      @Consumption.valueHelpDefinition: [{ entity: { name: 'ZI_DemoRosterTaxIdVH',
                                                     element: 'Stcd2' } }]
  key Stcd2,

      // No label: ZDEMO_DE_SYSTEM already says 'Integration target system'.
      @ObjectModel.text.element: ['SystemText']
      @Consumption.valueHelpDefinition: [{ entity: { name: 'ZI_DemoRosterSystemVH',
                                                     element: 'SystemId' } }]
  key SystemId,
}
