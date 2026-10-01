// nowforge-spec: bcb4e6cf4ece151f
import { Subflow, wfa, action } from '@servicenow/sdk/automation'
import { ReferenceColumn } from '@servicenow/sdk/core'

export const addDemoSubflowWorkNote = Subflow(
    {
        $id: Now.ID['adswn_subflow'],
        name: 'AddDemoWorkNote',
        description: 'Adds a work note to the provided incident.',
        runAs: 'system',
        inputs: {
            record: ReferenceColumn({ label: 'Incident', referenceTable: 'incident', mandatory: true })
        }
    },
    (params) => {
        wfa.action(
            action.core.updateRecord,
            { $id: Now.ID['adswn_update_incident'] },
            {
                table_name: 'incident',
                record: wfa.dataPill(params.inputs.record, 'reference'),
                values: TemplateValue({ work_notes: 'Demo subflow added this note.' })
            }
        )
    }
)