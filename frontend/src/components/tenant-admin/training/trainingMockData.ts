import type { TrainingModule, TrainingPackage } from './trainingTypes';

export const createTrainingId = (prefix: string): string =>
  `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;

export const INITIAL_MODULE_LIBRARY: TrainingModule[] = [
  {
    id: 'mod-001',
    title: 'Compliance and Product Fundamentals',
    modulePurpose:
      'Set a baseline for compliant selling behavior and ensure agents understand the core product conversation.',
    defaultRequired: true,
    attachments: [
      {
        id: 'att-mod-001',
        title: 'Agent Handbook',
        url: 'https://example.com/training/agent-handbook.pdf',
        attachmentType: 'pdf'
      },
      {
        id: 'att-mod-002',
        title: 'Program Overview Deck',
        url: 'https://example.com/training/program-overview.pdf',
        attachmentType: 'pdf'
      }
    ],
    moduleSteps: [
      {
        id: 'step-001',
        title: 'Review licensing and required disclosures',
        subtitle: 'Compliance Foundations',
        copy:
          'Review licensing requirements and mandatory disclosures before presenting plan options. Use the compliance checklist and disclosure guide as references while preparing your member conversation.',
        attachments: [
          {
            id: 'att-step-001',
            title: 'State Disclosure Quick Guide',
            url: 'https://example.com/training/disclosure-quick-guide.pdf',
            attachmentType: 'pdf'
          },
          {
            id: 'att-step-002',
            title: 'Compliance Readiness Checklist',
            url: 'https://example.com/training/compliance-checklist.pdf',
            attachmentType: 'pdf'
          }
        ],
        sectionQuiz: {
          id: 'quiz-001',
          title: 'Compliance Knowledge Check',
          sectionId: 'step-001',
          estimatedDurationMinutes: 3,
          quizTakes: [],
          questions: [
            {
              id: 'question-001',
              questionNumber: 1,
              questionText:
                'When should required plan disclosures be provided to a prospective member?',
              answerText: 'Before enrollment is completed',
              answerOrdinal: 'B',
              answerChoices: [
                {
                  id: 'choice-001',
                  answerText: 'Only after first payment clears',
                  answerTrueFalse: false,
                  answerOrdinal: 'A'
                },
                {
                  id: 'choice-002',
                  answerText: 'Before enrollment is completed',
                  answerTrueFalse: true,
                  answerOrdinal: 'B'
                },
                {
                  id: 'choice-003',
                  answerText: 'Disclosures are optional if asked verbally',
                  answerTrueFalse: false,
                  answerOrdinal: 'C'
                }
              ]
            }
          ]
        }
      },
      {
        id: 'step-002',
        title: 'Study product tiers and member fit scenarios',
        subtitle: 'Product Positioning',
        copy:
          'Study product tier differences and practice matching member profiles to the most appropriate bundle options without overpromising coverage outcomes.',
        attachments: [
          {
            id: 'att-step-003',
            title: 'Product Tier Matrix',
            url: 'https://example.com/training/product-tier-matrix.pdf',
            attachmentType: 'pdf'
          }
        ]
      }
    ]
  },
  {
    id: 'mod-002',
    title: 'Sales Conversation and Enrollment Execution',
    modulePurpose:
      'Prepare agents to run a compliant discovery call, position recommendations, and execute enrollment steps accurately.',
    defaultRequired: true,
    attachments: [
      {
        id: 'att-mod-003',
        title: 'Discovery Call Script',
        url: 'https://example.com/training/discovery-call-script.pdf',
        attachmentType: 'pdf'
      },
      {
        id: 'att-mod-004',
        title: 'Enrollment Workflow Map',
        url: 'https://example.com/training/enrollment-workflow-map.pdf',
        attachmentType: 'pdf'
      }
    ],
    moduleSteps: [
      {
        id: 'step-003',
        title: 'Conduct discovery and confirm member needs',
        subtitle: 'Discovery Call',
        copy:
          'Run a structured discovery call, confirm member goals, and document health and budget priorities so recommendations align with actual needs.',
        attachments: [
          {
            id: 'att-step-004',
            title: 'Discovery Question Bank',
            url: 'https://example.com/training/discovery-question-bank.pdf',
            attachmentType: 'pdf'
          }
        ]
      },
      {
        id: 'step-004',
        title: 'Complete enrollment and verify next actions',
        subtitle: 'Enrollment Execution',
        copy:
          'Complete enrollment accurately, confirm submitted details, and clearly explain next actions, timelines, and support contacts to the member.',
        attachments: [
          {
            id: 'att-step-005',
            title: 'Enrollment QA Checklist',
            url: 'https://example.com/training/enrollment-qa-checklist.pdf',
            attachmentType: 'pdf'
          },
          {
            id: 'att-step-006',
            title: 'Post-Enrollment Follow-Up Guide',
            url: 'https://example.com/training/post-enrollment-followup.pdf',
            attachmentType: 'pdf'
          }
        ],
        sectionQuiz: {
          id: 'quiz-002',
          title: 'Enrollment Execution Check',
          sectionId: 'step-004',
          estimatedDurationMinutes: 4,
          quizTakes: [],
          questions: [
            {
              id: 'question-002',
              questionNumber: 1,
              questionText:
                'What is the best next step after submitting an enrollment application?',
              answerText: 'Confirm follow-up expectations and provide support contact details',
              answerOrdinal: 'C',
              answerChoices: [
                {
                  id: 'choice-004',
                  answerText: 'Wait for the member to call back if needed',
                  answerTrueFalse: false,
                  answerOrdinal: 'A'
                },
                {
                  id: 'choice-005',
                  answerText: 'Close the case with no additional communication',
                  answerTrueFalse: false,
                  answerOrdinal: 'B'
                },
                {
                  id: 'choice-006',
                  answerText: 'Confirm follow-up expectations and provide support contact details',
                  answerTrueFalse: true,
                  answerOrdinal: 'C'
                }
              ]
            }
          ]
        }
      }
    ]
  },
  {
    id: 'mod-003',
    title: 'The MightyWELL Model',
    modulePurpose:
      'This section introduces agents to what MightyWELL is and how the platform works at a high level. \n' +
      'Agents should leave this section understanding:\n' +
      '\u2022 what MightyWELL is\n' +
      ' \u2022 how the platform combines multiple healthcare resources\n' +
      ' \u2022 the role of the health share for major medical events\n' +
      ' \u2022 how the bundles should be represented accurately\n' +
      'This section sets the foundation before agents move into specific bundle details later in the training.',
    defaultRequired: true,
    attachments: [
      {
        id: 'att-mod-005',
        title: 'MightyWELL Model Section Outline',
        url: 'https://example.com/training/mightywell-model-outline.pdf',
        attachmentType: 'pdf'
      }
    ],
    moduleSteps: [
      {
        id: 'step-005',
        title: 'What is MightyWELL?',
        subtitle: 'Review Overview',
        copy:
          'MightyWELL is a for-profit marketing platform that brings together multiple healthcare resources to create health bundle options for individuals and businesses.\nThrough the MightyWELL platform, members may access different bundle structures depending on their needs. Some bundles use copay-based care for everyday medical visits, while others may be structured to work alongside a Health Savings Account (HSA).\nFor larger medical events, the bundles may also include participation in a nonprofit health sharing program designed to support members when major healthcare needs arise.\nRather than operating as a traditional insurance carrier, MightyWELL focuses on combining practical healthcare resources into bundles that are designed to be simpler to use and more affordable than many traditional options.\nAgents should always use official MightyWELL materials when explaining how these bundles work.',
        attachments: [
          {
            id: 'att-step-007',
            title: 'MightyWELL Section 1 Overview Text',
            url: 'https://example.com/training/mightywell-model-overview.pdf',
            attachmentType: 'pdf'
          }
        ]
      },
      {
        id: 'step-006',
        title: 'MightyWELL Overview Guide',
        subtitle: 'Review Materials',
        copy:
          'Open the MightyWELL Overview Guide (PDF) and keep it available while completing the quiz. The guide explains the MightyWELL platform structure, copay-based bundle options, HSA-qualified bundle options, and the role of the health share.',
        attachments: [
          {
            id: 'att-step-008',
            title: 'MightyWELL Overview Guide',
            url: 'https://example.com/training/mightywell-overview-guide.pdf',
            attachmentType: 'pdf'
          }
        ]
      },
      {
        id: 'step-007',
        title: 'Section 1 Open-Book Knowledge Check',
        subtitle: 'Take Quiz',
        copy:
          'Complete the Section 1 open-book quiz using official MightyWELL documentation and the overview guide. Confirm understanding of platform positioning, bundle structure language, and the health share role for major medical events.',
        attachments: [],
        sectionQuiz: {
          id: 'quiz-003',
          title: 'Section 1 Quiz - The MightyWELL Model',
          sectionId: 'step-007',
          estimatedDurationMinutes: 8,
          quizTakes: [],
          questions: [
            {
              id: 'question-003',
              questionNumber: 1,
              questionText: 'Which statement best describes MightyWELL?',
              answerText:
                'A for-profit marketing platform that combines multiple healthcare resources to create health bundle options',
              answerOrdinal: 'C',
              answerChoices: [
                {
                  id: 'choice-007',
                  answerText: 'A traditional health insurance carrier',
                  answerTrueFalse: false,
                  answerOrdinal: 'A'
                },
                {
                  id: 'choice-008',
                  answerText: 'A government healthcare program',
                  answerTrueFalse: false,
                  answerOrdinal: 'B'
                },
                {
                  id: 'choice-009',
                  answerText:
                    'A for-profit marketing platform that combines multiple healthcare resources to create health bundle options',
                  answerTrueFalse: true,
                  answerOrdinal: 'C'
                }
              ]
            },
            {
              id: 'question-004',
              questionNumber: 2,
              questionText: 'True or False: MightyWELL itself is an insurance company.',
              answerText: 'False',
              answerOrdinal: 'B',
              answerChoices: [
                {
                  id: 'choice-010',
                  answerText: 'True',
                  answerTrueFalse: false,
                  answerOrdinal: 'A'
                },
                {
                  id: 'choice-011',
                  answerText: 'False',
                  answerTrueFalse: true,
                  answerOrdinal: 'B'
                }
              ]
            },
            {
              id: 'question-005',
              questionNumber: 3,
              questionText:
                'Which of the following may be included in MightyWELL bundle structures?',
              answerText: 'All of the above',
              answerOrdinal: 'D',
              answerChoices: [
                {
                  id: 'choice-012',
                  answerText: 'Copay care bundles for everyday medical needs',
                  answerTrueFalse: false,
                  answerOrdinal: 'A'
                },
                {
                  id: 'choice-013',
                  answerText: 'HSA-qualified bundle options',
                  answerTrueFalse: false,
                  answerOrdinal: 'B'
                },
                {
                  id: 'choice-014',
                  answerText:
                    'A nonprofit health sharing program designed to support major medical events',
                  answerTrueFalse: false,
                  answerOrdinal: 'C'
                },
                {
                  id: 'choice-015',
                  answerText: 'All of the above',
                  answerTrueFalse: true,
                  answerOrdinal: 'D'
                }
              ]
            },
            {
              id: 'question-006',
              questionNumber: 4,
              questionText:
                'True or False: MightyWELL bundles should be represented as traditional major medical insurance.',
              answerText: 'False',
              answerOrdinal: 'B',
              answerChoices: [
                {
                  id: 'choice-016',
                  answerText: 'True',
                  answerTrueFalse: false,
                  answerOrdinal: 'A'
                },
                {
                  id: 'choice-017',
                  answerText: 'False',
                  answerTrueFalse: true,
                  answerOrdinal: 'B'
                }
              ]
            },
            {
              id: 'question-007',
              questionNumber: 5,
              questionText:
                'True or False: Some MightyWELL bundles may use copay structures for everyday healthcare services.',
              answerText: 'True',
              answerOrdinal: 'A',
              answerChoices: [
                {
                  id: 'choice-018',
                  answerText: 'True',
                  answerTrueFalse: true,
                  answerOrdinal: 'A'
                },
                {
                  id: 'choice-019',
                  answerText: 'False',
                  answerTrueFalse: false,
                  answerOrdinal: 'B'
                }
              ]
            },
            {
              id: 'question-008',
              questionNumber: 6,
              questionText:
                'True or False: Some MightyWELL bundles may be structured to allow members to contribute to a Health Savings Account (HSA).',
              answerText: 'True',
              answerOrdinal: 'A',
              answerChoices: [
                {
                  id: 'choice-020',
                  answerText: 'True',
                  answerTrueFalse: true,
                  answerOrdinal: 'A'
                },
                {
                  id: 'choice-021',
                  answerText: 'False',
                  answerTrueFalse: false,
                  answerOrdinal: 'B'
                }
              ]
            },
            {
              id: 'question-009',
              questionNumber: 7,
              questionText: 'When explaining MightyWELL bundles to clients, agents should:',
              answerText: 'Use official MightyWELL materials to explain how the bundles work',
              answerOrdinal: 'A',
              answerChoices: [
                {
                  id: 'choice-022',
                  answerText:
                    'Use official MightyWELL materials to explain how the bundles work',
                  answerTrueFalse: true,
                  answerOrdinal: 'A'
                },
                {
                  id: 'choice-023',
                  answerText: 'Create their own marketing materials to simplify the explanation',
                  answerTrueFalse: false,
                  answerOrdinal: 'B'
                },
                {
                  id: 'choice-024',
                  answerText: 'Compare the bundles directly to traditional insurance',
                  answerTrueFalse: false,
                  answerOrdinal: 'C'
                }
              ]
            },
            {
              id: 'question-010',
              questionNumber: 8,
              questionText:
                'True or False: MightyWELL bundles may combine multiple healthcare resources to create a complete healthcare solution.',
              answerText: 'True',
              answerOrdinal: 'A',
              answerChoices: [
                {
                  id: 'choice-025',
                  answerText: 'True',
                  answerTrueFalse: true,
                  answerOrdinal: 'A'
                },
                {
                  id: 'choice-026',
                  answerText: 'False',
                  answerTrueFalse: false,
                  answerOrdinal: 'B'
                }
              ]
            },
            {
              id: 'question-011',
              questionNumber: 9,
              questionText:
                'True or False: The health sharing program is designed to support members during major medical events.',
              answerText: 'True',
              answerOrdinal: 'A',
              answerChoices: [
                {
                  id: 'choice-027',
                  answerText: 'True',
                  answerTrueFalse: true,
                  answerOrdinal: 'A'
                },
                {
                  id: 'choice-028',
                  answerText: 'False',
                  answerTrueFalse: false,
                  answerOrdinal: 'B'
                }
              ]
            },
            {
              id: 'question-012',
              questionNumber: 10,
              questionText:
                'True or False: Agents should only use official MightyWELL documentation when presenting the bundles.',
              answerText: 'True',
              answerOrdinal: 'A',
              answerChoices: [
                {
                  id: 'choice-029',
                  answerText: 'True',
                  answerTrueFalse: true,
                  answerOrdinal: 'A'
                },
                {
                  id: 'choice-030',
                  answerText: 'False',
                  answerTrueFalse: false,
                  answerOrdinal: 'B'
                }
              ]
            }
          ]
        }
      }
    ]
  },
  {
    id: 'mod-004',
    title: 'Using the Agent Portal',
    modulePurpose:
      'This section teaches agents how to navigate the MightyWELL agent portal and locate the resources they will use when presenting bundles and enrolling clients.\n' +
      'Agents should leave this section understanding how to:\n' +
      '\u2022 navigate the portal dashboard\n' +
      ' \u2022 locate product information and bundle guides\n' +
      ' \u2022 generate proposal documents\n' +
      ' \u2022 access enrollment links\n' +
      ' \u2022 view commissions\n' +
      ' \u2022 locate support resources\n' +
      'Agents will use the portal throughout the rest of the training to reference materials and answer quiz questions.',
    defaultRequired: true,
    attachments: [],
    moduleSteps: [
      {
        id: 'step-008',
        title: 'Using the MightyWELL Agent Portal',
        subtitle: 'Review Overview',
        copy:
          'Using the MightyWELL Agent Portal\n' +
          'The MightyWELL agent portal is the central location where agents access product information, generate proposals, enroll clients, and manage their business.\n' +
          'From the portal, agents can:\n' +
          '\u2022 review available bundles\n' +
          ' \u2022 download bundle guides and product materials\n' +
          ' \u2022 generate proposal documents\n' +
          ' \u2022 access enrollment links\n' +
          ' \u2022 track their groups and members\n' +
          ' \u2022 view commissions\n' +
          ' \u2022 access support when needed\n' +
          'Agents should become familiar with the portal navigation so they can quickly locate the information they need when working with clients.',
        attachments: []
      },
      {
        id: 'step-009',
        title: 'Explore the Portal',
        subtitle: 'Hands-on navigation',
        copy:
          'Agents should log into the portal and review the main navigation areas, including:\n' +
          '\u2022 Dashboard\n' +
          ' \u2022 Products\n' +
          ' \u2022 Marketing\n' +
          ' \u2022 My Groups / Members\n' +
          ' \u2022 Commissions\n' +
          ' \u2022 Support\n' +
          'Agents should also locate the Products section and open at least one bundle guide for reference.\n' +
          'Agents should also locate the Marketing section, where proposal documents can be generated.',
        attachments: []
      },
      {
        id: 'step-010',
        title: 'Section 2 Open-Book Knowledge Check',
        subtitle: 'Take Quiz',
        copy:
          'Complete the open-book quiz for this section. You are encouraged to reference the portal while answering the questions.',
        attachments: [],
        sectionQuiz: {
          id: 'quiz-004',
          title: 'Section 2 Quiz - Using the Agent Portal',
          sectionId: 'step-010',
          estimatedDurationMinutes: 8,
          quizTakes: [],
          questions: [
            {
              id: 'question-013',
              questionNumber: 1,
              questionText: 'What is the primary purpose of the MightyWELL agent portal?',
              answerText: 'To manage agent business, access product information, and enroll clients',
              answerOrdinal: 'B',
              answerChoices: [
                {
                  id: 'choice-031',
                  answerText: 'To submit insurance claims',
                  answerTrueFalse: false,
                  answerOrdinal: 'A'
                },
                {
                  id: 'choice-032',
                  answerText: 'To manage agent business, access product information, and enroll clients',
                  answerTrueFalse: true,
                  answerOrdinal: 'B'
                },
                {
                  id: 'choice-033',
                  answerText: 'To process medical billing',
                  answerTrueFalse: false,
                  answerOrdinal: 'C'
                }
              ]
            },
            {
              id: 'question-014',
              questionNumber: 2,
              questionText:
                'True or False: Agents can access product information and bundle guides through the portal.',
              answerText: 'True',
              answerOrdinal: 'A',
              answerChoices: [
                {
                  id: 'choice-034',
                  answerText: 'True',
                  answerTrueFalse: true,
                  answerOrdinal: 'A'
                },
                {
                  id: 'choice-035',
                  answerText: 'False',
                  answerTrueFalse: false,
                  answerOrdinal: 'B'
                }
              ]
            },
            {
              id: 'question-015',
              questionNumber: 3,
              questionText: 'Where can agents locate the available MightyWELL bundles and bundle guides?',
              answerText: 'Products section',
              answerOrdinal: 'A',
              answerChoices: [
                {
                  id: 'choice-036',
                  answerText: 'Products section',
                  answerTrueFalse: true,
                  answerOrdinal: 'A'
                },
                {
                  id: 'choice-037',
                  answerText: 'Commissions section',
                  answerTrueFalse: false,
                  answerOrdinal: 'B'
                },
                {
                  id: 'choice-038',
                  answerText: 'Support section',
                  answerTrueFalse: false,
                  answerOrdinal: 'C'
                }
              ]
            },
            {
              id: 'question-016',
              questionNumber: 4,
              questionText: 'True or False: The portal allows agents to generate proposals for potential clients.',
              answerText: 'True',
              answerOrdinal: 'A',
              answerChoices: [
                {
                  id: 'choice-039',
                  answerText: 'True',
                  answerTrueFalse: true,
                  answerOrdinal: 'A'
                },
                {
                  id: 'choice-040',
                  answerText: 'False',
                  answerTrueFalse: false,
                  answerOrdinal: 'B'
                }
              ]
            },
            {
              id: 'question-017',
              questionNumber: 5,
              questionText:
                'Which section of the portal allows agents to track their enrolled groups or members?',
              answerText: 'My Groups / Members',
              answerOrdinal: 'A',
              answerChoices: [
                {
                  id: 'choice-041',
                  answerText: 'My Groups / Members',
                  answerTrueFalse: true,
                  answerOrdinal: 'A'
                },
                {
                  id: 'choice-042',
                  answerText: 'Products',
                  answerTrueFalse: false,
                  answerOrdinal: 'B'
                },
                {
                  id: 'choice-043',
                  answerText: 'Dashboard',
                  answerTrueFalse: false,
                  answerOrdinal: 'C'
                }
              ]
            },
            {
              id: 'question-018',
              questionNumber: 6,
              questionText: 'True or False: Agents can view their commissions through the portal.',
              answerText: 'True',
              answerOrdinal: 'A',
              answerChoices: [
                {
                  id: 'choice-044',
                  answerText: 'True',
                  answerTrueFalse: true,
                  answerOrdinal: 'A'
                },
                {
                  id: 'choice-045',
                  answerText: 'False',
                  answerTrueFalse: false,
                  answerOrdinal: 'B'
                }
              ]
            },
            {
              id: 'question-019',
              questionNumber: 7,
              questionText:
                'If an agent needs help or has a question about the platform, where should they look first?',
              answerText: 'Support section',
              answerOrdinal: 'A',
              answerChoices: [
                {
                  id: 'choice-046',
                  answerText: 'Support section',
                  answerTrueFalse: true,
                  answerOrdinal: 'A'
                },
                {
                  id: 'choice-047',
                  answerText: 'Products section',
                  answerTrueFalse: false,
                  answerOrdinal: 'B'
                },
                {
                  id: 'choice-048',
                  answerText: 'Commissions section',
                  answerTrueFalse: false,
                  answerOrdinal: 'C'
                }
              ]
            },
            {
              id: 'question-020',
              questionNumber: 8,
              questionText:
                'True or False: The portal provides access to enrollment links used to sign up clients.',
              answerText: 'True',
              answerOrdinal: 'A',
              answerChoices: [
                {
                  id: 'choice-049',
                  answerText: 'True',
                  answerTrueFalse: true,
                  answerOrdinal: 'A'
                },
                {
                  id: 'choice-050',
                  answerText: 'False',
                  answerTrueFalse: false,
                  answerOrdinal: 'B'
                }
              ]
            },
            {
              id: 'question-021',
              questionNumber: 9,
              questionText:
                'True or False: Agents should review bundle guides and materials in the portal before presenting bundles to clients.',
              answerText: 'True',
              answerOrdinal: 'A',
              answerChoices: [
                {
                  id: 'choice-051',
                  answerText: 'True',
                  answerTrueFalse: true,
                  answerOrdinal: 'A'
                },
                {
                  id: 'choice-052',
                  answerText: 'False',
                  answerTrueFalse: false,
                  answerOrdinal: 'B'
                }
              ]
            },
            {
              id: 'question-022',
              questionNumber: 10,
              questionText: 'How does an agent generate a proposal document in the portal?',
              answerText:
                'Go to the Marketing tab, select Individual or Business, choose the product, enter client information, and download the proposal',
              answerOrdinal: 'A',
              answerChoices: [
                {
                  id: 'choice-053',
                  answerText:
                    'Go to the Marketing tab, select Individual or Business, choose the product, enter client information, and download the proposal',
                  answerTrueFalse: true,
                  answerOrdinal: 'A'
                },
                {
                  id: 'choice-054',
                  answerText: 'Go to the Commissions tab and create a proposal',
                  answerTrueFalse: false,
                  answerOrdinal: 'B'
                },
                {
                  id: 'choice-055',
                  answerText: 'Go to the Support tab and request a proposal',
                  answerTrueFalse: false,
                  answerOrdinal: 'C'
                }
              ]
            }
          ]
        }
      }
    ]
  }
];

export const INITIAL_PACKAGES: TrainingPackage[] = [
  {
    id: 'pkg-mw-001',
    title: 'MightyWell Agent Qualification Core Package',
    packagePurpose:
      'Train newly onboarded agents on compliance basics, product positioning, and readiness checks before selling.',
    status: 'Draft',
    version: '1.0.0',
    certificate: {
      packageName: 'MightyWell Agent Qualification Core Package',
      certificateName: 'MightyWell Agent Qualification Core Certificate',
      certificateDetails:
        'Awarded for achieving a cumulative quiz score of 70% or higher for this package.',
      certificateImageUrl:
        'https://res.cloudinary.com/doi8qjcv6/image/upload/v1774995133/customers/mightywell/cmedal_uyhlz1.png'
    },
    moduleAssignments: [
      {
        id: 'pkg-mod-001',
        moduleId: 'mod-001',
        required: true,
        order: 1
      },
      {
        id: 'pkg-mod-portal',
        moduleId: 'mod-004',
        required: true,
        order: 2
      },
      {
        id: 'pkg-mod-002',
        moduleId: 'mod-002',
        required: true,
        order: 3
      }
    ]
  }
];
